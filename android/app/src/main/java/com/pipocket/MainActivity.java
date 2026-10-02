package com.pipocket;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * 连接页：手填地址 / 扫描局域网找到电脑上的 Pi Pocket / 从最近记录里挑。
 * 连接成功一次后会记住，下次启动直接进 WebView。
 */
public class MainActivity extends Activity {

	/** 由 WebActivity 打开时带上，表示"这是从 App 内进设置页" */
	public static final String EXTRA_FROM_APP = "from_app";

	public static final String PREFS = "pi-pocket";
	public static final String KEY_HOST = "host";
	public static final String KEY_TOKEN = "token";
	public static final String KEY_LAST = "lastOk";

	private EditText hostInput;
	private EditText tokenInput;
	private TextView statusText;
	private LinearLayout deviceList;
	private Button connectBtn;
	private Button scanBtn;
	private volatile boolean scanning = false;
	private boolean fromApp = false;

	@Override
	protected void onCreate(Bundle savedInstanceState) {
		super.onCreate(savedInstanceState);

		SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
		fromApp = getIntent().getBooleanExtra(EXTRA_FROM_APP, false);
		String lastOk = prefs.getString(KEY_LAST, null);

		// 首次启动且已有可用地址：直接进主界面。
		// 但如果是从 App 内点"连接设置"进来的，就留在本页让用户改。
		if (!fromApp && lastOk != null && !lastOk.isEmpty()) {
			Intent i = new Intent(this, WebActivity.class);
			i.putExtra(WebActivity.EXTRA_HOST, lastOk);
			i.putExtra(WebActivity.EXTRA_TOKEN, prefs.getString(KEY_TOKEN, ""));
			startActivity(i);
			finish();
			return;
		}

		setContentView(R.layout.activity_connect);
		hostInput = findViewById(R.id.hostInput);
		tokenInput = findViewById(R.id.tokenInput);
		statusText = findViewById(R.id.statusText);
		deviceList = findViewById(R.id.deviceList);
		connectBtn = findViewById(R.id.connectBtn);
		scanBtn = findViewById(R.id.scanBtn);

		String host = prefs.getString(KEY_HOST, "");
		if (host.isEmpty()) host = Net.guessGateway();
		hostInput.setText(host);
		tokenInput.setText(prefs.getString(KEY_TOKEN, ""));

		if (fromApp) {
			// 从 App 内进来改设置：给出明确的标题和返回入口
			connectBtn.setText("保存并连接");
		}

		connectBtn.setOnClickListener(v -> {
			String h = Net.normalizeHost(hostInput.getText().toString());
			if (h == null) {
				statusText.setText(R.string.bad_address);
				return;
			}
			hostInput.setText(h);
			String token = tokenInput.getText().toString().trim();
			getSharedPreferences(PREFS, MODE_PRIVATE).edit()
					.putString(KEY_HOST, h)
					.putString(KEY_TOKEN, token)
					.apply();
			statusText.setText(getString(R.string.connecting, h));
			connectBtn.setEnabled(false);
			probe(h, token, null);
		});

		scanBtn.setOnClickListener(v -> startScan());

		renderRecent();
	}

	private void renderRecent() {
		deviceList.removeAllViews();
		SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
		String raw = prefs.getString("recent", "[]");
		List<String> hosts = new ArrayList<>();
		try {
			JSONArray arr = new JSONArray(raw);
			for (int i = 0; i < arr.length(); i++) {
				String h = arr.optString(i, "");
				if (!h.isEmpty()) hosts.add(h);
			}
		} catch (Exception ignored) {
		}

		String current = Net.normalizeHost(hostInput.getText().toString());
		if (current != null && !hosts.contains(current)) hosts.add(0, current);

		for (final String h : hosts) {
			LinearLayout row = new LinearLayout(this);
			row.setOrientation(LinearLayout.VERTICAL);
			row.setBackgroundResource(R.drawable.device_bg);
			row.setPadding(dp(14), dp(12), dp(14), dp(12));
			LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
					ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
			lp.bottomMargin = dp(8);
			row.setLayoutParams(lp);

			TextView title = new TextView(this);
			title.setText(h);
			title.setTextColor(Color.parseColor("#E7EBF3"));
			title.setTextSize(15);
			row.addView(title);

			TextView sub = new TextView(this);
			sub.setText("点一下连接 · 长按删除");
			sub.setTextColor(Color.parseColor("#8B95A9"));
			sub.setTextSize(11);
			row.addView(sub);

			row.setOnClickListener(v -> {
				hostInput.setText(h);
				connectBtn.performClick();
			});
			row.setOnLongClickListener(v -> {
				removeRecent(h);
				renderRecent();
				return true;
			});
			deviceList.addView(row);
		}

		if (hosts.isEmpty()) {
			TextView empty = new TextView(this);
			empty.setText("还没有记录，先在上方填地址，或点「扫描局域网」");
			empty.setTextColor(Color.parseColor("#8B95A9"));
			empty.setTextSize(12);
			empty.setPadding(dp(4), dp(6), dp(4), dp(6));
			deviceList.addView(empty);
		}
	}

	private void removeRecent(String host) {
		SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
		List<String> keep = new ArrayList<>();
		try {
			JSONArray arr = new JSONArray(prefs.getString("recent", "[]"));
			for (int i = 0; i < arr.length(); i++) {
				String h = arr.optString(i, "");
				if (!h.isEmpty() && !h.equals(host)) keep.add(h);
			}
		} catch (Exception ignored) {
		}
		prefs.edit().putString("recent", new JSONArray(keep).toString()).apply();
	}

	private void rememberOk(String host, String token) {
		SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
		List<String> list = new ArrayList<>();
		list.add(host);
		try {
			JSONArray arr = new JSONArray(prefs.getString("recent", "[]"));
			for (int i = 0; i < arr.length() && list.size() < 8; i++) {
				String h = arr.optString(i, "");
				if (!h.isEmpty() && !list.contains(h)) list.add(h);
			}
		} catch (Exception ignored) {
		}
		prefs.edit()
				.putString("recent", new JSONArray(list).toString())
				.putString(KEY_HOST, host)
				.putString(KEY_TOKEN, token)
				.putString(KEY_LAST, host)
				.apply();
	}

	/* ------------------------------ 连接探测 ------------------------------ */

	/** 先探活（/api/health），是 Pi Pocket 才进 WebView，否则给出明确提示 */
	private void probe(String host, String token, String note) {
		new Thread(() -> {
			String err = Net.probe(host, token);
			runOnUiThread(() -> {
				connectBtn.setEnabled(true);
				if (err == null) {
					rememberOk(host, token);
					if (fromApp) {
						// 从 App 内改的地址：直接退回，WebActivity.onResume 会检测到变化并重连
						finish();
					} else {
						Intent i = new Intent(MainActivity.this, WebActivity.class);
						i.putExtra(WebActivity.EXTRA_HOST, host);
						i.putExtra(WebActivity.EXTRA_TOKEN, token);
						startActivity(i);
						finish();
					}
				} else {
					statusText.setText(getString(R.string.connect_failed, host) + "\n" + err);
				}
			});
		}).start();
	}

	/* ------------------------------ 局域网扫描 ------------------------------ */

	private void startScan() {
		if (scanning) return;
		scanning = true;
		scanBtn.setEnabled(false);
		statusText.setText(R.string.scanning);
		deviceList.removeAllViews();

		new Thread(() -> {
			final List<String> found = new ArrayList<>();
			List<String> result = Net.scan((host, done, total) -> runOnUiThread(() -> {
				if (!scanning) return;
				statusText.setText(getString(R.string.scanning) + " " + done + "/" + total
						+ (found.isEmpty() ? "" : "  ·  已找到 " + found.size()));
			}), found);
			found.addAll(result);

			runOnUiThread(() -> {
				scanning = false;
				scanBtn.setEnabled(true);
				if (found.isEmpty()) {
					statusText.setText(R.string.found_none);
					return;
				}
				statusText.setText("找到 " + found.size() + " 台，点一下连接");
				deviceList.removeAllViews();
				for (final String h : found) {
					LinearLayout row = new LinearLayout(MainActivity.this);
					row.setOrientation(LinearLayout.VERTICAL);
					row.setBackgroundResource(R.drawable.device_bg);
					row.setPadding(dp(14), dp(12), dp(14), dp(12));
					LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
							ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
					lp.bottomMargin = dp(8);
					row.setLayoutParams(lp);

					TextView title = new TextView(MainActivity.this);
					title.setText(h);
					title.setTextColor(Color.parseColor("#7BD88F"));
					title.setTextSize(15);
					row.addView(title);

					TextView sub = new TextView(MainActivity.this);
					sub.setText("运行中的 Pi Pocket");
					sub.setTextColor(Color.parseColor("#8B95A9"));
					sub.setTextSize(11);
					row.addView(sub);

					row.setOnClickListener(v -> {
						hostInput.setText(h);
						connectBtn.performClick();
					});
					deviceList.addView(row);
				}
			});
		}).start();
	}

	@Override
	protected void onResume() {
		super.onResume();
		// 从 WebActivity 返回（连接失败）时，回到连接页并允许重填
		connectBtn.setEnabled(true);
	}

	private int dp(int v) {
		return Math.round(getResources().getDisplayMetrics().density * v);
	}
}
