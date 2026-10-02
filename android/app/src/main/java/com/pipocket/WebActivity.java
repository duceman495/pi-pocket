package com.pipocket;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.webkit.JavascriptInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

/**
 * 主界面：一个全屏 WebView 加载电脑上的 Pi Pocket 网页。
 * 网页本身是手机浏览器版前端，所以功能、样式完全一致；这里只补
 * 原生能力：系统返回键 = 网页返回、断线重连、连不上就退回连接页。
 */
public class WebActivity extends Activity {

	/**
	 * 暴露给网页的接口。
	 *
	 * 为什么需要：App 记住地址后会直接进 WebView，用户就再也找不到改地址的地方了。
	 * 网页里的菜单通过 window.PiPocketNative.openSettings() 把原生设置页叫出来，
	 * 这样"随时能改网关地址"这件事在 App 内是可达的。
	 */
	public class NativeBridge {
		@JavascriptInterface
		public void openSettings() {
			runOnUiThread(() -> {
				returningFromSettings = true;
				Intent i = new Intent(WebActivity.this, MainActivity.class);
				i.putExtra(MainActivity.EXTRA_FROM_APP, true);
				startActivity(i);
			});
		}

		/** 网页用它判断"我是不是跑在 App 里"，是才显示"连接设置"菜单项 */
		@JavascriptInterface
		public String info() {
			return "{\"app\":true,\"host\":\"" + host + "\",\"version\":\"" + APP_VERSION + "\"}";
		}

		@JavascriptInterface
		public void reconnect() {
			runOnUiThread(() -> load());
		}
	}

	public static final String EXTRA_HOST = "host";
	public static final String EXTRA_TOKEN = "token";
	/** 与 build.sh 里的 --version-name 保持一致（不用 Gradle，没有 BuildConfig） */
	public static final String APP_VERSION = "0.2.0";

	private WebView webView;
	private FrameLayout root;
	private String host;
	private String token;
	private View errorView;
	private boolean pageLoadedOnce = false;
	/**
	 * 最近一次主框架加载失败的时间。
	 *
	 * 为什么需要：WebView 加载失败时也会回调 onPageFinished（内容是它自带的
	 * "Webpage not available" 错误页），如果用 onPageFinished 去清错误提示，
	 * 会把刚显示出来的"更改电脑地址"界面立刻擦掉。这里用时间戳避开。
	 */
	private long lastErrorAt = 0;
	/**
	 * 是否刚从"连接设置"页回来。
	 *
	 * 必须无条件重连，不能只在地址变化时重连 —— 否则会出现死锁：
	 * 地址本来就填对了，只是电脑端服务没开；用户去设置页看一眼又返回，
	 * 地址没变 → 不重连 → 永远停在错误页。
	 */
	private boolean returningFromSettings = false;

	@SuppressLint("SetJavaScriptEnabled")
	@Override
	protected void onCreate(Bundle savedInstanceState) {
		super.onCreate(savedInstanceState);
		setContentView(R.layout.activity_main);
		root = findViewById(R.id.root);

		host = getIntent().getStringExtra(EXTRA_HOST);
		token = getIntent().getStringExtra(EXTRA_TOKEN);
		if (host == null) {
			host = getSharedPreferences(MainActivity.PREFS, MODE_PRIVATE).getString(MainActivity.KEY_HOST, null);
		}

		webView = new WebView(this);
		// 允许用 chrome://inspect / adb forward 调试 WebView 里的页面（自用工具，常开）
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
			WebView.setWebContentsDebuggingEnabled(true);
		}
		webView.setLayoutParams(new FrameLayout.LayoutParams(
				ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
		webView.setBackgroundColor(Color.parseColor("#0B0D12"));
		root.addView(webView);

		WebSettings s = webView.getSettings();
		s.setJavaScriptEnabled(true);
		s.setDomStorageEnabled(true);
		s.setDatabaseEnabled(true);
		s.setLoadWithOverviewMode(false);
		s.setUseWideViewPort(false);
		s.setMediaPlaybackRequiresUserGesture(false);
		s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
		s.setCacheMode(WebSettings.LOAD_DEFAULT);
		s.setTextZoom(100);
		// 局域网里是明文 http/ws，Android 9+ 默认禁止，这里由 network_security_config + 下面这行共同放行
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
			s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
		}
		CookieManager.getInstance().setAcceptCookie(true);

		webView.setWebViewClient(new WebViewClient() {
			@Override
			public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
				Uri uri = request.getUrl();
				String h = uri.getHost();
				// 只允许在本机 Pi Pocket 里跳转，外链交给系统浏览器
				if (h != null && (h.equals(hostOf(host)) || uri.toString().startsWith("http://" + host))) {
					return false;
				}
				if (h == null || (!uri.getScheme().startsWith("http"))) return false;
				try {
					startActivity(new Intent(Intent.ACTION_VIEW, uri));
				} catch (Exception ignored) {
				}
				return true;
			}

			@Override
			public void onPageFinished(WebView view, String url) {
				pageLoadedOnce = true;
				// 刚发生过主框架错误就不要清提示（错误页也会走到这里）
				if (System.currentTimeMillis() - lastErrorAt > 3000) removeError();
			}

			@Override
			public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
				if (request.isForMainFrame()) {
					lastErrorAt = System.currentTimeMillis();
					showError("连不上电脑上的 Pi Pocket\n" + host + "\n" + error.getDescription());
				}
			}

			// 老设备/边缘情况走这个重载
			@SuppressWarnings("deprecation")
			@Override
			public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
				lastErrorAt = System.currentTimeMillis();
				showError("连不上电脑上的 Pi Pocket\n" + host + "\n" + description);
			}
		});

		// 暴露给页面的原生能力（连接设置等）
		webView.addJavascriptInterface(new NativeBridge(), "PiPocketNative");

		webView.setWebChromeClient(new WebChromeClient() {
			@Override
			public boolean onConsoleMessage(ConsoleMessage m) {
				return true;
			}

			@Override
			public void onPermissionRequest(PermissionRequest request) {
				request.deny();
			}
		});

		load();
	}

	private static String hostOf(String hostPort) {
		if (hostPort == null) return "";
		int i = hostPort.lastIndexOf(':');
		return i > 0 ? hostPort.substring(0, i) : hostPort;
	}

	private void load() {
		String url = "http://" + host + "/" + (token != null && !token.isEmpty()
				? "?token=" + Uri.encode(token) : "");
		webView.loadUrl(url);
	}

	/** 连不上时给一个明确的出口：重试，或者改地址 */
	private void showError(String msg) {
		if (errorView != null) {
			root.removeView(errorView);
			errorView = null;
		}

		LinearLayout box = new LinearLayout(this);
		box.setOrientation(LinearLayout.VERTICAL);
		box.setBackgroundColor(Color.parseColor("#0B0D12"));
		box.setPadding(dp(24), dp(72), dp(24), dp(24));
		box.setLayoutParams(new FrameLayout.LayoutParams(
				ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

		TextView text = new TextView(this);
		text.setText(msg);
		text.setTextColor(Color.parseColor("#FFB4B4"));
		text.setTextSize(14);
		box.addView(text);

		TextView hint = new TextView(this);
		hint.setText("\n可能的原因：\n· 电脑上 Pi Pocket 没启动（./pocket start）\n"
				+ "· 手机和电脑不在同一个 Wi-Fi\n· 地址填错了\n");
		hint.setTextColor(Color.parseColor("#8B95A9"));
		hint.setTextSize(13);
		box.addView(hint);

		Button retry = new Button(this);
		retry.setText("重试");
		retry.setBackgroundResource(R.drawable.btn_primary);
		retry.setTextColor(Color.parseColor("#DBE8FF"));
		retry.setAllCaps(false);
		retry.setOnClickListener(v -> {
			removeError();
			load();
		});
		box.addView(retry);

		Button change = new Button(this);
		change.setText("更改电脑地址");
		change.setBackgroundResource(R.drawable.btn_ghost);
		change.setTextColor(Color.parseColor("#E7EBF3"));
		change.setAllCaps(false);
		LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
				ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
		lp.topMargin = dp(8);
		change.setLayoutParams(lp);
		change.setOnClickListener(v -> {
			returningFromSettings = true;
			Intent i = new Intent(this, MainActivity.class);
			i.putExtra(MainActivity.EXTRA_FROM_APP, true);
			startActivity(i);
		});
		box.addView(change);

		errorView = box;
		root.addView(errorView);
	}

	private void removeError() {
		if (errorView != null) {
			root.removeView(errorView);
			errorView = null;
		}
	}

	/** 退回连接页（保留最近地址） */
	private void navBack() {
		SharedPreferences prefs = getSharedPreferences(MainActivity.PREFS, MODE_PRIVATE);
		prefs.edit().remove(MainActivity.KEY_LAST).apply();
		startActivity(new Intent(this, MainActivity.class));
		finish();
	}

	@Override
	public boolean onKeyDown(int keyCode, KeyEvent event) {
		if (keyCode == KeyEvent.KEYCODE_BACK) {
			// 网页自己处理返回（会话列表 ← 对话），到底了再交回原生
			webView.evaluateJavascript(
					"(function(){try{return document.getElementById('view-chat') && "
							+ "!document.getElementById('view-chat').classList.contains('hidden') ? '1':'0'}catch(e){return '0'}})()",
					value -> {
						if ("\"1\"".equals(value)) {
							webView.evaluateJavascript("history.back()", null);
						} else if (webView.canGoBack()) {
							webView.goBack();
						} else {
							moveTaskToBack(true); // 回桌面，后台的 agent 继续跑
						}
					});
			return true;
		}
		return super.onKeyDown(keyCode, event);
	}

	/**
	 * 从"连接设置"页回来后，如果地址变了就重新连。
	 * 这样用户改完网关不用手动杀 App。
	 */
	@Override
	protected void onResume() {
		super.onResume();
		SharedPreferences prefs = getSharedPreferences(MainActivity.PREFS, MODE_PRIVATE);
		String savedHost = prefs.getString(MainActivity.KEY_HOST, null);
		String savedToken = prefs.getString(MainActivity.KEY_TOKEN, "");
		if (savedHost == null || savedHost.isEmpty()) return;
		boolean hostChanged = !savedHost.equals(host);
		boolean tokenChanged = !(savedToken == null ? "" : savedToken).equals(token == null ? "" : token);

		// 从设置页回来 → 一律重连；否则地址/令牌变了也重连
		if (returningFromSettings || hostChanged || tokenChanged) {
			returningFromSettings = false;
			host = savedHost;
			token = savedToken;
			removeError();
			pageLoadedOnce = false;
			load();
		}
	}

	@Override
	protected void onDestroy() {
		if (webView != null) {
			root.removeView(webView);
			webView.destroy();
			webView = null;
		}
		super.onDestroy();
	}

	private int dp(int v) {
		return Math.round(getResources().getDisplayMetrics().density * v);
	}
}
