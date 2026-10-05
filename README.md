# Modern DeX for PC

Samsung の "DeX for PC" は One UI 7 で廃止されました。**Modern DeX for PC** は、その代わりとなる Windows 用クライアントです。Galaxy 端末に 1920×1080 などの仮想ディスプレイを作り、そこで動く DeX デスクトップ(タスクバー、フリーフォームウィンドウ)を Windows のウィンドウに表示して、マウスとキーボードで操作します。

- 映像と操作: [scrcpy-server](https://github.com/Genymobile/scrcpy) v4.1 の `new_display` 機能を使用。デコードと描画は WebView2 の WebCodecs が担当(ハードウェアデコード)
- アプリ本体: Tauri 2(Rust)と React / Tailwind CSS
- 対応機能: クリップボードの双方向同期、ドラッグ & ドロップによるファイル転送、音声(Opus)、統計オーバーレイ、Win キーや Alt+Tab の DeX への転送、日本語 IME、Flex モード(ウィンドウサイズに合わせて解像度を変更)

> 動作確認環境: SCG37 (Galaxy) / Android 16 / One UI 8.5 と Windows 11 ARM64 (Snapdragon X Plus)。

---

## 前提条件

| 項目 | 内容 |
|---|---|
| OS | Windows 10 / 11(x64 または ARM64) |
| WebView2 | Windows 11 には標準で入っています。Windows 10 は [Evergreen Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) を導入してください |
| メディア機能 | **Windows N / KN エディション**では H.264 と Opus のデコードに [Media Feature Pack](https://support.microsoft.com/topic/media-feature-pack-list-for-windows-n-editions-c1c6fffa-d052-8338-7a79-a4bb980a700a) が必要です |
| 端末 | Android 11 以降の Galaxy(DeX 対応機種)。「開発者向けオプション → USB デバッグ」を ON にしてください |
| ADB | Android SDK Platform-Tools(下記「ADB の配置」を参照) |

### 開発環境(ソースからビルドする場合)

- Node.js 20 以上
- Rust stable(`rustup`)
- Visual Studio Build Tools(C++ ワークロード、MSVC、Windows 11 SDK)

```powershell
# Visual Studio 2026 Build Tools(ARM64 と x64 の両方のツールを含む)
winget install --id Microsoft.VisualStudio.BuildTools --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.VC.Tools.ARM64 --add Microsoft.VisualStudio.Component.VC.Tools.x86.x64 --includeRecommended"

# ARM64 PC から x64 版もビルドする場合
rustup target add x86_64-pc-windows-msvc
```

## セットアップと起動

```powershell
npm i
npm run fetch:bin   # scrcpy-server v4.1 を取得し、SHA-256 を検証
npm run dev         # 開発モードで起動(tauri dev)
```

端末を USB で接続し、接続画面のデバイスカードにある **「DeX を開始」** を押してください。

### npm スクリプト

| スクリプト | 内容 |
|---|---|
| `npm run dev` | 開発モードで起動 |
| `npm run build` | Rust のホストアーキテクチャ向けのインストーラー(NSIS / MSI)を作成(`--target` を明示するので、x64 版 Node を ARM64 PC で使っていてもファイル名のアーキテクチャが正しくなります) |
| `npm run build:arm64` / `npm run build:x64` | アーキテクチャを指定してビルド |
| `npm run portable` | インストール不要のフォルダ `portable/Modern DeX for PC/`(`ModernDeX.exe` と `bin/scrcpy-server`)を作成。フォルダごとコピーすれば、どこでも exe をダブルクリックで起動できます |
| `npm run typecheck` | TypeScript の型チェック |
| `npm test` | Vitest と `cargo test` を実行 |
| `npm run fetch:bin` | scrcpy-server を取得(`-- --force` を付けると再ダウンロード) |

インストーラーは `src-tauri/target/<target>/release/bundle/{nsis,msi}/` に出力されます(例: `Modern DeX for PC_0.1.0_arm64-setup.exe`)。

## ADB の配置

`adb.exe` は次の順番で探します。

1. 設定画面の「adb.exe のパス」(ファイルまたはフォルダを指定)
2. アプリのリソースフォルダ内の `bin\adb.exe`(`src-tauri/resources/bin/` に `adb.exe`、`AdbWinApi.dll`、`AdbWinUsbApi.dll` を置いてビルドすると、インストーラーに同梱されます)
3. `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe`(Android Studio の既定の場所)
4. `%ANDROID_HOME%\platform-tools` または `%ANDROID_SDK_ROOT%\platform-tools`
5. `PATH`

Platform-Tools 単体は <https://developer.android.com/tools/releases/platform-tools> から入手できます。

## scrcpy-server を v4.1 に固定している理由

scrcpy-server は、クライアントから渡されたバージョン文字列がサーバー自身のバージョンと一致しないと起動しません。また、このアプリは v4 で導入された次の仕様を前提にしています。

- 映像ストリームの session packet(解像度変更の通知)
- `RESIZE_DISPLAY`(21)と `SCAN_FILE`(22)
- flex display

このため、バージョンは `SERVER_VERSION = "4.1"`(`src-tauri/src/binaries.rs`)で固定し、ダウンロードしたファイルは SHA-256 で検証しています。

手動で入手する場合は、[リリースページ](https://github.com/Genymobile/scrcpy/releases/tag/v4.1)から `scrcpy-server-v4.1` をダウンロードし、`src-tauri/resources/bin/scrcpy-server` として保存してください。

- SHA-256: `deacb991ed2509715160ffdc7907e47b4160eb30d1566217e9047fd5b8850cae`

## Wi-Fi 接続(ワイヤレスデバッグ)

1. 端末の「開発者向けオプション → ワイヤレスデバッグ」を ON にします
2. 初回のみ、「ペアリングコードによるデバイスのペア設定」に表示された IP:ポートと 6 桁のコードを、接続画面の「ペア設定」に入力します
3. ワイヤレスデバッグ画面に表示される IP:ポートを「接続」に入力します

Wi-Fi 接続時は、デバイスカードに「Wi-Fi」と表示されます。帯域が足りない場合は、設定でビットレートを 4〜8 Mbps 程度に下げてください。

## 仕組み

```
Galaxy                                           Windows (Tauri)
┌──────────────────────────────┐   adb forward   ┌─────────────────────────────┐
│ scrcpy-server v4.1           │◀──────────────▶│ Rust                        │
│  new_display=1920x1080/240   │ video/audio/    │  demuxer → WebSocket (127.0.0.1,
│  vd_system_decorations=true  │ control sockets │           ランダムポート + トークン)
│  → DeX ランチャーが自動起動   │                 │  control ◀─ 入力 (WS)        │
└──────────────────────────────┘                 │ WebView2                    │
                                                 │  WebCodecs → canvas         │
                                                 │  AudioDecoder → AudioWorklet│
                                                 └─────────────────────────────┘
```

- 映像データの受け渡しにはローカルの WebSocket を使います(`/stream` はバイナリ、`/events` はキーボードフック用)。Tauri の invoke は制御系の操作にだけ使います
- 入力メッセージ(キー / テキスト / マウス / スクロール / BACK)はフロントエンドでエンコードし、Rust が型とサイズを検証して転送します。クリップボード / RESET_VIDEO / 解像度変更 / SCAN_FILE は Rust 側でエンコードします

## One UI 8.5 での DeX の変化

- 単体の DeX ランチャー `com.sec.android.app.desktoplauncher` は存在しません。DeX は One UI Home に統合され、`SECONDARY_HOME` は `com.sec.android.app.launcher/com.honeyspace.dexservice.SecondaryLauncher` に解決されます
- システムデコレーション付きの仮想ディスプレイを作ると、DeX のタスクバーが自動的に表示されます。ただし、アプリは全画面で開きます。そこでこのアプリは、ディスプレイ作成後に `cmd window set-display-windowing-mode -d <id> 5` を実行してフリーフォームに切り替え、DeX と同じウィンドウ表示にしています(設定の「アプリをウィンドウで開く」、既定で ON)
- `force_desktop_mode_on_external_displays` と `enable_freeform_support` を実行中に変更しても、効果はありませんでした。設定の「デスクトップモードを強制」は古い機種向けのオプションです(変更した値は保存しておき、終了時に元に戻します。クラッシュした場合は次回起動時に戻します)
- 仮想ディスプレイで開いたアプリは、スマホ画面のウィンドウサイズ(縦長・画面より大きい・全画面)をそのまま引き継ぐため、そのままでは見切れたり DeX のタスクバーに隠れたりします。このアプリは約 1 秒ごとに `dumpsys activity activities` でディスプレイ上のタスクとその境界を調べ、`am task resize` で「ディスプレイの幅いっぱい × タスクバーを除いた高さ」に配置します。タスクバーの高さは `dumpsys window` の `DexTaskbarWindow` が申告する `navigationBars` インセットから求めます
  - 配置し直すのは初回表示のときだけです。利用者がウィンドウを動かしたりサイズを変えたりした後は追従をやめ、そのウィンドウが画面外やタスクバーの下へ出たときだけ引き戻します
  - Flex モードで解像度が変わったときは、各ウィンドウの相対的な位置と大きさを保ったまま新しい領域へ配置し直します
  - DeX ランチャー、システム UI、IME、ピクチャーインピクチャーのタスクは対象外です。タスクや インセットを取得できない端末では警告を出すだけで、セッションはそのまま続きます

## 操作

| 操作 | 動作 |
|---|---|
| 左クリック / ドラッグ | タップ / スワイプ(範囲選択) |
| 右クリック | DeX のコンテキストメニュー |
| ホイール(マウス) | Android のスクロール |
| 2 本指の上下 / 左右(タッチパッド) | タッチのスワイプとして送ります。Instagram のタブ切り替えのように、指のドラッグでしか反応しない画面も操作できます(設定の「トラックパッドジェスチャー」、既定で ON)。縦横どちらの操作かは少し動かしてから確定するため、縦スクロールの出だしのわずかな横ぶれで横スワイプになることはありません |
| 2 本指のピンチ(タッチパッド) | カーソル位置を中心とした 2 点タッチの拡大縮小 |
| キーボード | そのまま入力。英字は keycode、記号と数字は文字として送るため、JIS 配列でも刻印どおりの文字が入力されます |
| 日本語 IME | Windows の IME で変換し、確定した文字列を端末のクリップボード経由で貼り付けます |
| Win / Win+キー / Alt+Tab / Alt+Esc / Ctrl+Esc / Alt+F4 | 低レベルキーボードフックで Windows 側の処理を止め、DeX に送ります(ウィンドウにフォーカスがあり、ストリーミング中で、設定が ON のときだけ) |
| F11 | フルスクリーンの切り替え |
| Ctrl+Shift+S | 統計オーバーレイの表示切り替え(FPS / デコード遅延 / ビットレート / 解像度 / 接続方式 / キュー / 音声バッファ) |
| ファイルをドロップ | 端末の `/sdcard/Download/`(設定で変更可)へ転送し、メディアスキャンを実行 |
| 操作バー | 画面上端にマウスを置く、上端のハンドルを押す、または Alt キーで表示されます。戻る / ホーム / 履歴と音量を直接操作でき、スマホ画面 / 統計 / ログ / 設定 / フルスクリーン / 切断は「その他」にあります。「戻る」は、端末がスリープしているときは画面をオンにします |
| スマホ画面オフ(ツールバーのスマホアイコン) | スマホ本体の画面だけを消灯し、DeX は動かし続けます(`SET_DISPLAY_POWER`)。切断すると画面は自動でオンに戻ります。電源ボタンで画面を消すと端末がスリープし、DeX の画面も止まるため、こちらを使ってください |

## 既知の制限

- **Ctrl+Alt+Del と Win+L** は OS が処理するため、フックできません
- IME で確定した文字列(ASCII 以外)は、端末のクリップボードに設定してから Ctrl+V で貼り付けます。そのため、端末のクリップボードの内容がその文字列に置き換わります。なお、`SET_CLIPBOARD` の paste フラグ(KEYCODE_PASTE)は One UI の一部の入力欄で無視されたため、使っていません
- 端末がスリープすると、仮想ディスプレイも黒くなります(ツールバーの「戻る」で画面をオンにできます)。接続中は `stay_awake` によりタイムアウトではスリープしませんが、電源ボタンを押すとスリープします。スマホの画面だけを消したい場合は、ツールバーの「スマホ画面オフ」を使ってください
- スマホ画面のオン/オフを切り替えると、Samsung の「設定」アプリなど一部のアプリはロック時と同じように自分で終了します
- Android の画面キーボードは、既定では DeX 上に表示しません(設定の「画面キーボード (IME) の表示先」で変更できます)。PC のキーボードと IME で入力する前提です
- マウスカーソルは Windows のカーソルがそのまま表示されます。DeX 側のカーソル形状(テキスト入力用の I ビームなど)は反映されません
- DeX のタスクバーは自動で隠れる設定になっている場合があります。その場合は画面下端にマウスを移動してください
- 音声の取得には Android 11 以上が必要です。取得できない場合は映像のみで続行します
- 同じ端末で公式 scrcpy と同時に使うことはできません(サーバーの jar ファイルを共有しているため)

## トラブルシュート

| 症状 | 対処 |
|---|---|
| デバイスが一覧に出ない | `adb devices` で確認してください。`unauthorized` と表示される場合は、端末に表示される USB デバッグの許可ダイアログで許可してください |
| `pm` や `am` が失敗する | マルチユーザー環境(セキュアフォルダなど)では `--user 0` が必要です。このアプリのコマンドには常に `--user 0` を付けています |
| 起動に失敗する | ツールバーまたは接続画面の「ログ」を確認してください。scrcpy-server の出力も表示されます |
| 終了後に状態が残る | `adb forward --list` で `localabstract:scrcpy_…` が残っていないか確認してください(クラッシュ後の残りは次回起動時に自動で削除します)。`adb shell dumpsys display` に `"scrcpy"` のディスプレイが残っていないかも確認してください |
| 映像が出ない / 乱れる | 環境チェックで H.264 のデコードが使えるか確認してください(N エディションは Media Feature Pack が必要)。ビットレートを下げると改善する場合があります |
| 音が途切れる | 統計オーバーレイの「音声バッファ / 途切れ」を確認してください。Wi-Fi 接続の場合は USB 接続を推奨します |

**ログの場所**

- `%LOCALAPPDATA%\dev.moderndex.pc\logs\modern-dex.log`
- 設定ファイル: `%APPDATA%\dev.moderndex.pc\settings.json`

## 開発メモ

- `src-tauri/src/` の構成
  - `adb.rs`: `track-devices`、sync プロトコルによる push(進捗付き)、forward
  - `session.rs`: サーバーの起動、ソケット接続、各タスク
  - `demuxer.rs`: v4 のストリーム形式の解析
  - `control.rs`: 制御メッセージの検証とエンコード
  - `ws.rs`: WebSocket サーバー
  - `clipboard.rs`: クリップボード同期
  - `file_transfer.rs`: ファイル転送
  - `keyboard_hook.rs`: 低レベルキーボードフック
  - `dex.rs`: DeX ランチャーの起動、フリーフォームへの切り替え、`dumpsys` の解析、設定の復元
  - `layout.rs`: ウィンドウを置く場所の決定(セーフエリア、手動リサイズの尊重、Flex での再配置)
- `src/lib/`: 純粋ロジックとテスト(control-codec、keymap、coords、h264、stream-protocol、trackpad)
- `src/media/`: `VideoPipeline`(WebCodecs)、`AudioPlayer` と ring-buffer worklet、`InputController`
- テストベクタは scrcpy の `app/tests/test_control_msg_serialize.c` と `test_device_msg_deserialize.c` から移植しています
- `adb push` は標準出力がパイプだと進捗(`[ NN%]`)を出力しません。そのため、ファイル転送は ADB の sync プロトコルを直接実装しています

## ライセンス

scrcpy-server は Apache License 2.0(© Genymobile, Romain Vimont)で提供されています。
