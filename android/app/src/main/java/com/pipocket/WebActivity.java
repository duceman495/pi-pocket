package com.pipocket;

import android.annotation.SuppressLint;
import android.app.Activity;
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
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

/**
 * 主界面：一个全屏 WebView 加载电脑上的 Pi Pocket 网页。
 * 网页本身是手机浏览器版前端，所以功能、样式完全一致；这里只补
 * 原生能力：系统返回键 = 网页返回、断线重连、连不上就退回连接页。
 */
public class WebActivity extends Activity {

	public static final String EXTRA_HOST = "host";
	public static final String EXTRA_TOKEN = "token";

	private WebView webView;
	private FrameLayout root;
	private String host;
	private String token;
	private TextView errorView;
	private boolean pageLoadedOnce = false;

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
				removeError();
			}

			@Override
			public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
				if (request.isForMainFrame()) {
					showError("连不上电脑上的 Pi Pocket\n" + host + "\n" + error.getDescription());
				}
			}
		});

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

	private void showError(String msg) {
		if (errorView == null) {
			errorView = new TextView(this);
			errorView.setBackgroundColor(Color.parseColor("#0B0D12"));
			errorView.setTextColor(Color.parseColor("#FFB4B4"));
			errorView.setTextSize(14);
			errorView.setPadding(dp(24), dp(80), dp(24), dp(24));
			errorView.setLayoutParams(new FrameLayout.LayoutParams(
					ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
			errorView.setOnClickListener(v -> navBack());
			root.addView(errorView);
		}
		errorView.setText(msg + "\n\n点屏幕退回连接页，或再点一次重试");
		errorView.setOnClickListener(v -> {
			removeError();
			load();
		});
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
