#!/usr/bin/env node
// Session screen: does the IME textarea (.ime-sink) keep / regain keyboard
// focus across real clicks, keys, dialogs, IME composition and idle time?
//
//   node scripts/e2e/session-ime.mjs            (headless; HEADED=1 to watch)
//
// Prints a JSON summary on stdout (progress on stderr). Exit code 0 only when
// every asserted step passes.
import { fixtures, firstLine, freePort, launchChromium, loadPlaywright, log, pageInitScript, startStreamServer, startVite } from "./harness.mjs";

const NOT_AUTOMATED = [
  { item: "実 OS の IME (Microsoft IME / TSF の候補ウィンドウ・確定操作)", reason: "CDP Input.imeSetComposition/insertText はレンダラーへ合成イベントを直接送るだけで、OS の IME を経由しない" },
  { item: "WebView2 (Tauri) 固有のネイティブウィンドウフォーカス (Alt+Tab、他ウィンドウへの切替・復帰)", reason: "headless Chromium では OS ウィンドウのフォーカス移動を再現できない (Playwright はページを常にフォーカス扱いにする)" },
  { item: "低レベルキーボードフック (/events WebSocket 経由の Win/Alt キー)", reason: "スタブ WebSocket サーバーはフックイベントを送らない" },
  { item: "OS からのファイルドラッグ&ドロップ、実際の全画面切替", reason: "Tauri のネイティブイベント・ウィンドウ API はモックで即時に応答するだけ" },
];

const results = [];
let page;

const snapshot = () =>
  page.evaluate(() => ({
    active: window.__e2e.desc(document.activeElement),
    imeFocused: !!document.activeElement?.classList?.contains("ime-sink"),
    imeBlurs: window.__e2e.imeBlurs,
    focusLogLength: window.__e2e.focusLog.length,
  }));

const matches = (expect, snap) => (expect === "ime-sink" ? snap.imeFocused : expect === "dialog" ? snap.active.includes(" in dialog#") : true);

/**
 * expect: "ime-sink" | "dialog" | null (recorded, not asserted).
 * noBlur: the textarea must not lose focus at all during the step.
 * check: extra assertion, returns { ok, detail }.
 */
async function step(name, action, { expect = "ime-sink", noBlur = false, check, settleMs = noBlur ? 300 : 0, note } = {}) {
  const before = await snapshot();
  let error;
  try {
    await action();
  } catch (e) {
    error = firstLine(e);
  }
  if (settleMs) await page.waitForTimeout(settleMs);
  let snap = await snapshot();
  // Focus may come back asynchronously (React effects): give it a moment.
  for (let deadline = Date.now() + 1000; !error && expect && !matches(expect, snap) && Date.now() < deadline; ) {
    await page.waitForTimeout(50);
    snap = await snapshot();
  }
  let extra;
  if (!error && check) {
    try {
      extra = await check();
    } catch (e) {
      extra = { ok: false, detail: firstLine(e) };
    }
  }
  const blursInStep = snap.imeBlurs - before.imeBlurs;
  const asserted = expect !== null || noBlur || !!check;
  const pass = asserted ? !error && matches(expect, snap) && (!noBlur || blursInStep === 0) && (extra?.ok ?? true) : null;
  const focusEvents = await page.evaluate(([from]) => window.__e2e.focusLog.slice(from).map((e) => `${e.t} ${e.type} ${e.target ?? e.active ?? ""}${e.related && e.related !== "null" ? ` -> ${e.related}` : ""}`), [before.focusLogLength]);
  const result = { step: name, expect, activeElement: snap.active, imeBlurs: snap.imeBlurs, blursInStep, pass };
  if (extra?.detail !== undefined) result.check = extra.detail;
  if (error) result.error = error;
  if (note) result.note = note;
  if (focusEvents.length) result.focusEvents = focusEvents;
  results.push(result);
  log(`${pass === null ? "INFO" : pass ? "PASS" : "FAIL"} ${name} active=${snap.active} blurs=${snap.imeBlurs}${error ? ` error=${error}` : ""}`);
  return result;
}

// The reveal handle is inert exactly while the toolbar is shown.
const toolbarVisible = () => page.evaluate(() => document.querySelector('[aria-label="操作バーを表示"]')?.inert === true);

async function run() {
  const { chromium } = await loadPlaywright();
  const ws = await startStreamServer();
  const vite = await startVite(Number(process.env.E2E_PORT) || (await freePort()));
  log(`vite ${vite.url}, stub ws 127.0.0.1:${ws.port}`);
  let browser;
  try {
    browser = await launchChromium(chromium, { headless: !process.env.HEADED });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "ja-JP" });
    await context.addInitScript(pageInitScript, fixtures(ws.port));
    page = await context.newPage();
    const consoleErrors = [];
    page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
    page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${firstLine(e)}`));
    await page.goto(vite.url);

    const canvas = page.locator("canvas");
    const button = (name, exact = true) => page.getByRole("button", { name, exact });
    const menuItem = (name) => page.getByRole("menuitem", { name });
    const dialog = (name) => page.getByRole("dialog", { name });
    // Every scenario starts from the textarea, so one failure does not leak
    // into the next (closing a dialog restores focus to where it was before).
    const refocus = () => canvas.click({ position: { x: 200, y: 350 } });
    const openMenu = async () => {
      await refocus();
      // The bar may have auto-hidden (inert) by now: Alt shows it again.
      await page.keyboard.press("Alt");
      await button("その他").click();
      await page.getByRole("menu").waitFor();
    };
    const imeText = (text) => async () => {
      const sent = await page.evaluate(() => window.__e2e.invokes.filter((i) => i.cmd === "send_ime_text").map((i) => i.args.text));
      return { ok: sent.includes(text), detail: `send_ime_text: ${JSON.stringify(sent)}` };
    };
    const compositionSince = async (from) => page.evaluate(([n]) => window.__e2e.composition.slice(n).map((c) => `${c.type}(${JSON.stringify(c.data)})`), [from]);

    // ---- into the session screen ----
    await step("connect-screen: DeX を開始 をクリック", async () => {
      await button("DeX を開始").click();
      await page.locator("textarea.ime-sink").waitFor({ state: "attached" });
    }, { expect: null });

    // (a) right after the session screen appears (stream still connecting)
    await step("(a) session-screen 表示直後", async () => {}, { noBlur: true });

    await step("stream 接続 → 操作ガイド自動表示", async () => {
      ws.release();
      await page.getByRole("img", { name: "接続済み" }).waitFor();
      await dialog("DeX の操作を始めましょう").waitFor();
    }, { expect: "dialog" });
    await step("(c) 自動ガイドを「使い始める」で閉じる", async () => {
      await button("使い始める").click();
      await dialog("DeX の操作を始めましょう").waitFor({ state: "detached" });
    });

    // (b) canvas
    await step("(b) canvas クリック", () => canvas.click({ position: { x: 640, y: 420 } }), { noBlur: true });
    await step("(b) canvas 右クリック", () => canvas.click({ button: "right", position: { x: 300, y: 300 } }), { noBlur: true });
    await step("(b) canvas ドラッグ", async () => {
      await page.mouse.move(400, 400);
      await page.mouse.down();
      await page.mouse.move(600, 500, { steps: 5 });
      await page.mouse.up();
    }, { noBlur: true });
    await step("キーボード入力 (abc + Enter)", async () => {
      await page.keyboard.type("abc");
      await page.keyboard.press("Enter");
    }, { noBlur: true });
    await step("Alt キーで操作バー表示", () => page.keyboard.press("Alt"), { noBlur: true });

    // (c) toolbar buttons
    await step("(c) 戻る", async () => {
      await refocus();
      await button("戻る").click();
    });
    await step("(c) ホーム", () => button("ホーム").click());
    await step("(c) 履歴", () => button("履歴").click());
    await step("(c) ミュート", () => button("ミュート").click());
    await step("(c) 音量スライダーをクリック", async () => {
      await refocus();
      await page.getByRole("slider", { name: "音量" }).click();
    }, { note: "range input は mousedown を通すので一度フォーカスを取り、pointerup で .ime-sink に返す" });
    await step("(c) 音量スライダーをドラッグ", async () => {
      await refocus();
      await page.keyboard.press("Alt");
      const box = await page.getByRole("slider", { name: "音量" }).boundingBox();
      await page.mouse.move(box.x + 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 5 });
      await page.mouse.up();
    });
    await step("(c) フォーカスを持ったスライダーが操作バーの自動非表示で inert になる", async () => {
      await refocus();
      await page.keyboard.press("Alt");
      await page.getByRole("slider", { name: "音量" }).focus();
      await page.mouse.move(640, 500);
      await page.waitForFunction(() => document.querySelector('[aria-label="操作バーを表示"]')?.inert === false, null, { timeout: 6000 });
    });
    await step("(b) スライダー後に canvas クリック", () => canvas.click({ position: { x: 640, y: 420 } }));

    // Connecting / reconnecting overlay (covers the canvas)
    await step("(c) 再接続中オーバーレイをクリック", async () => {
      await refocus();
      ws.hold();
      await page.getByText("接続が途切れました。再接続しています…").waitFor();
      await page.mouse.click(640, 420);
      await page.mouse.click(300, 600);
    }, { noBlur: true });
    await step("再接続完了後", async () => {
      ws.release();
      await page.getByText("接続が途切れました。再接続しています…").waitFor({ state: "detached" });
    }, { noBlur: true });

    // Toasts (here: a failing phone-screen request)
    await step("(c) エラートーストをクリック", async () => {
      await refocus();
      await page.evaluate(() => window.__e2e.fail.add("set_phone_screen"));
      await openMenu();
      await menuItem(/^スマホ画面を/).click();
      const toast = page.getByText("スマホの画面を切り替えられませんでした");
      await toast.waitFor();
      await toast.click();
      await page.evaluate(() => window.__e2e.fail.delete("set_phone_screen"));
    });

    // (c) menu open / close
    await step("(c) メニューを開く", openMenu);
    await step("(c) メニューを「その他」で閉じる", async () => {
      await button("その他").click();
      await page.getByRole("menu").waitFor({ state: "detached" });
    });
    await openMenu();
    await step("(c) メニューを Escape で閉じる", async () => {
      await page.keyboard.press("Escape");
      await page.getByRole("menu").waitFor({ state: "detached" });
    });
    await openMenu();
    await step("(c) メニューを canvas クリックで閉じる", async () => {
      await canvas.click({ position: { x: 640, y: 600 } });
      await page.getByRole("menu").waitFor({ state: "detached" });
    });
    await openMenu();
    await step("(c) メニュー → パフォーマンス統計 ON", () => menuItem(/^パフォーマンス統計/).click());
    await openMenu();
    await step("(c) メニュー → パフォーマンス統計 OFF", () => menuItem(/^パフォーマンス統計/).click());
    await openMenu();
    await step("(c) メニュー → スマホ画面をオフ", () => menuItem(/^スマホ画面を/).click());
    await openMenu();
    await step("(c) メニュー → 全画面表示", () => menuItem(/^全画面/).click());
    await openMenu();
    await step("(c) メニュー → 全画面を終了", () => menuItem(/^全画面/).click());

    // (c) settings dialog
    const settingsDialog = dialog("設定");
    const openSettings = (label) =>
      step(`(c) メニュー → 設定 を開く${label}`, async () => {
        await openMenu();
        await menuItem("設定").click();
        await settingsDialog.waitFor();
      }, { expect: "dialog" });
    await openSettings("");
    await step("(c) 設定を「閉じる」で閉じる", async () => {
      await settingsDialog.getByRole("button", { name: "閉じる" }).click();
      await settingsDialog.waitFor({ state: "detached" });
    });
    await openSettings(" (2)");
    await step("(c) 設定を Escape で閉じる", async () => {
      await page.keyboard.press("Escape");
      await settingsDialog.waitFor({ state: "detached" });
    });
    await openSettings(" (3)");
    await step("(c) 設定を「キャンセル」で閉じる", async () => {
      await settingsDialog.getByRole("button", { name: "キャンセル" }).click();
      await settingsDialog.waitFor({ state: "detached" });
    });
    await openSettings(" (4)");
    await step("(c) 設定を「保存」で閉じる", async () => {
      await settingsDialog.getByRole("button", { name: "保存" }).click();
      await settingsDialog.waitFor({ state: "detached" });
    });
    await openSettings(" (5)");
    await step("(c) 設定を背景クリックで閉じる", async () => {
      await page.mouse.click(4, 796);
      await settingsDialog.waitFor({ state: "detached" });
    });

    // (c) guide dialog from the menu
    const guide = dialog("DeX の操作を始めましょう");
    const openGuide = (label) =>
      step(`(c) メニュー → 操作ガイド を開く${label}`, async () => {
        await openMenu();
        await menuItem("操作ガイド").click();
        await guide.waitFor();
      }, { expect: "dialog" });
    await openGuide("");
    await step("(c) 操作ガイドを Escape で閉じる", async () => {
      await page.keyboard.press("Escape");
      await guide.waitFor({ state: "detached" });
    });
    await openGuide(" (2)");
    await step("(c) 操作ガイドを「閉じる」で閉じる", async () => {
      await guide.getByRole("button", { name: "閉じる" }).click();
      await guide.waitFor({ state: "detached" });
    });

    // (c) app launcher
    const apps = dialog("アプリを開く");
    const openApps = (label) =>
      step(`(c) アプリ を開く${label}`, async () => {
        await refocus();
        await button("アプリ").click();
        await apps.getByRole("button", { name: /^Chrome/ }).waitFor();
      }, { expect: "dialog" });
    await openApps("");
    await step("(c) アプリを Escape で閉じる", async () => {
      await page.keyboard.press("Escape");
      await apps.waitFor({ state: "detached" });
    });
    await openApps(" (2)");
    await step("(c) アプリを起動して閉じる (Chrome)", async () => {
      await apps.getByRole("button", { name: /^Chrome/ }).click();
      await apps.waitFor({ state: "detached" });
    });

    // (c) disconnect confirmation (destroyContent: true), cancelled
    const confirm = page.getByRole("alertdialog", { name: "DeX を切断しますか？" });
    const openConfirm = (label) =>
      step(`(c) メニュー → DeX を切断 (確認ダイアログ)${label}`, async () => {
        await openMenu();
        await menuItem("DeX を切断").click();
        await confirm.waitFor();
      }, { expect: "dialog" });
    await openConfirm("");
    await step("(c) 切断確認を「キャンセル」で閉じる", async () => {
      await confirm.getByRole("button", { name: "キャンセル" }).click();
      await confirm.waitFor({ state: "detached" });
    });
    await openConfirm(" (2)");
    await step("(c) 切断確認を Escape で閉じる", async () => {
      await page.keyboard.press("Escape");
      await confirm.waitFor({ state: "detached" });
    });

    // (c) log panel (not modal)
    const logClose = page.locator("div.fixed", { hasText: "ログ" }).getByRole("button", { name: "閉じる" });
    await step("(c) メニュー → ログ を開く", async () => {
      await openMenu();
      await menuItem("ログ").click();
      await logClose.waitFor();
    });
    await step("(c) ログを「閉じる」で閉じる", async () => {
      await logClose.click();
      await logClose.waitFor({ state: "detached" });
    });
    await step("(b) ログ後に canvas クリック", () => canvas.click({ position: { x: 640, y: 420 } }));

    // (d) IME composition through CDP (renderer-level, no OS IME)
    const cdp = await page.context().newCDPSession(page);
    await canvas.click({ position: { x: 500, y: 450 } });
    let mark = await page.evaluate(() => window.__e2e.composition.length);
    await step("(d) IME 変換開始 (imeSetComposition 'に')", () => cdp.send("Input.imeSetComposition", { text: "に", selectionStart: 1, selectionEnd: 1 }), {
      noBlur: true,
      check: async () => {
        const events = await compositionSince(mark);
        const composing = await page.evaluate(() => document.querySelector("textarea.ime-sink")?.classList.contains("ime-sink--composing"));
        return { ok: events.includes('compositionstart("")') && composing, detail: `${events.join(" ")} composingClass=${composing}` };
      },
    });
    await step("(d) IME 変換中 (imeSetComposition 'にほん')", () => cdp.send("Input.imeSetComposition", { text: "にほん", selectionStart: 3, selectionEnd: 3 }), { noBlur: true });
    await step("(d) IME 確定 (insertText '日本')", () => cdp.send("Input.insertText", { text: "日本" }), {
      noBlur: true,
      check: async () => {
        const events = await compositionSince(mark);
        const sent = await imeText("日本")();
        const composing = await page.evaluate(() => document.querySelector("textarea.ime-sink")?.classList.contains("ime-sink--composing"));
        return { ok: events.includes('compositionend("日本")') && sent.ok && !composing, detail: `${events.join(" ")} | ${sent.detail} composingClass=${composing}` };
      },
    });
    mark = await page.evaluate(() => window.__e2e.composition.length);
    await step("(d) IME 変換取消 (composition 'てすと' → '')", async () => {
      await cdp.send("Input.imeSetComposition", { text: "てすと", selectionStart: 3, selectionEnd: 3 });
      await page.waitForTimeout(100);
      await cdp.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
    }, {
      noBlur: true,
      check: async () => {
        const events = await compositionSince(mark);
        return { ok: events.includes("compositionstart(\"\")") && events.some((e) => e.startsWith("compositionend")), detail: events.join(" ") };
      },
    });
    mark = await page.evaluate(() => window.__e2e.composition.length);
    await step("(d) IME 変換中に「戻る」→ 確定", async () => {
      await cdp.send("Input.imeSetComposition", { text: "かな", selectionStart: 2, selectionEnd: 2 });
      await button("戻る").click();
      await cdp.send("Input.insertText", { text: "仮名" });
    }, {
      noBlur: true,
      check: async () => {
        const events = await compositionSince(mark);
        const sent = await imeText("仮名")();
        return { ok: events.includes('compositionend("仮名")') && sent.ok, detail: `${events.join(" ")} | ${sent.detail}` };
      },
    });

    // (e) idle: toolbar auto-hide (3 s), device status polling (3 s), stats timer
    await refocus();
    await page.mouse.move(640, 500);
    const pollsBefore = await page.evaluate(() => window.__e2e.invokes.filter((i) => i.cmd === "get_session_device_status").length);
    await step("(e) 5.5 秒放置", () => page.waitForTimeout(5500), {
      noBlur: true,
      check: async () => {
        const hidden = !(await toolbarVisible());
        const polls = (await page.evaluate(() => window.__e2e.invokes.filter((i) => i.cmd === "get_session_device_status").length)) - pollsBefore;
        return { ok: true, detail: `toolbarHidden=${hidden} deviceStatusPolls=${polls}` };
      },
    });
    await step("(c) 隠れた操作バーのハンドルをクリック", async () => {
      await button("操作バーを表示").click();
      await page.waitForFunction(() => document.querySelector('[aria-label="操作バーを表示"]')?.inert === true);
    });
    await refocus();
    await page.mouse.move(640, 500);
    await page.waitForFunction(() => document.querySelector('[aria-label="操作バーを表示"]')?.inert === false, null, { timeout: 6000 });
    await step("(c) 上端に 0.7 秒置いて操作バー表示", async () => {
      await page.mouse.move(640, 1, { steps: 5 });
      await page.waitForTimeout(700);
      await page.mouse.move(640, 500);
    }, {
      noBlur: true,
      check: async () => ({ ok: true, detail: `toolbarVisible=${await toolbarVisible()}` }),
    });

    const failed = results.filter((r) => r.pass === false);
    const summary = {
      ok: failed.length === 0,
      asserted: results.filter((r) => r.pass !== null).length,
      passed: results.filter((r) => r.pass === true).length,
      failed: failed.map((r) => r.step),
      imeBlursTotal: (await snapshot()).imeBlurs,
      // focus events only where something happened to the textarea
      steps: results.map(({ focusEvents, ...r }) => (focusEvents && (r.pass === false || r.blursInStep > 0) ? { ...r, focusEvents } : r)),
      wsAccepted: ws.accepted(),
      unknownIpcCommands: [...new Set(await page.evaluate(() => window.__e2e.unknownCommands))],
      consoleErrors: [...new Set(consoleErrors)].slice(0, 10),
      notAutomated: NOT_AUTOMATED,
    };
    if (process.env.E2E_VERBOSE) summary.focusLog = await page.evaluate(() => window.__e2e.focusLog);
    console.log(JSON.stringify(summary, null, 2));
    return summary.ok ? 0 : 1;
  } finally {
    await browser?.close().catch(() => undefined);
    await vite.stop();
    await ws.close();
  }
}

run().then(
  (code) => process.exit(code),
  (e) => {
    log("harness error:", e?.stack ?? e);
    if (results.length) console.log(JSON.stringify({ ok: false, error: firstLine(e), steps: results }, null, 2));
    process.exit(2);
  },
);
