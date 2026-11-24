# chrome-mcp-router

[chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) のプロキシラッパー。自動再接続とプロジェクトベースの設定機能を追加します。

- **自動再接続**: Chrome のクラッシュを検知し、Chrome が再起動したら自動的に子プロセスを再起動する
- **プロジェクトルーティング**: ポート番号を直接指定する代わりに、プロジェクト名で Chrome のデバッグ URL を解決できる

## 動作要件

- Node.js 26.13.0 (`package.json` の `engines`)
- リモートデバッグを有効にして起動した Chrome (例: `--remote-debugging-port=9222`)

## インストール

```bash
# npx で実行（インストール不要）
npx -y chrome-mcp-router@latest --project myproject
```

## 使い方

### .mcp.json の設定

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-mcp-router@latest", "--project", "myproject"]
    }
  }
}
```

### CLI オプション

```
chrome-mcp-router --project <name>
chrome-mcp-router --browserUrl <url>
```

| オプション | 説明 |
| --- | --- |
| `--project <name>` | 設定ファイルのプロジェクト名で `browserUrl` を解決する。プロジェクトが見つからない場合はエラーで終了する |
| `--browserUrl <url>` | Chrome のデバッグ URL を直接指定する (例: `http://127.0.0.1:9222`)。`http://` または `https://` で始まる必要がある |

その他のフラグ (`--slim`, `--no-usage-statistics` など) は `chrome-devtools-mcp` に pass-through されます。

### 設定ファイル

`~/.config/chrome-mcp-router/config.json` にプロジェクト名と URL のマッピングを記述します。

```json
{
  "projects": {
    "myproject": {
      "browserUrl": "http://127.0.0.1:9200"
    },
    "anotherproject": {
      "browserUrl": "http://127.0.0.1:9201"
    }
  }
}
```

## 動作

1. `--project` が指定された場合、設定ファイルからプロジェクト名で `browserUrl` を解決する
2. `chrome-devtools-mcp` を子プロセスとして起動し (固定された依存パッケージ、現在はバージョン `1.13.0`)、stdio を双方向にプロキシする
3. Chrome の `/json/version` エンドポイントを 3 秒ごとにポーリングして生存確認する
4. Chrome がクラッシュ後に再起動したことを検知すると、古い子プロセスを停止して新しく起動し、MCP handshake を再送してセッションを透過的に復元する
5. `--project` が指定されている場合、5 秒ごとに設定ファイルから `browserUrl` を再解決し、変更されていれば新しい URL で子プロセスを再起動する

子プロセスの起動に失敗した場合 (例: Node 実行ファイルが利用できない場合)、ブリッジは stderr にエラーを記録し、Chrome に接続できる間は 5 秒ごとの復旧タイマーで再試行する。子プロセスのコールバックと handshake の待機状態は、その子プロセスにだけ関連付けられる。再起動時には SIGTERM を送り、5 秒以内に終了しなければ SIGKILL を送る。以前の子プロセスの終了を確認してから、新しい子プロセスを起動する。さらに 5 秒経っても終了を確認できない場合、キュー内のリクエストに切断エラーを返し、以前の子プロセスの管理を継続したまま復旧を再試行する。

子プロセスが動いておらず再接続中でもない間 (例: Chrome に接続できない状態で子プロセスが終了した後)、クライアントからのリクエスト (`initialize` を除く) には JSON-RPC エラー (`-32000`) が返る。子プロセスが動いている間は、Chrome がダウンしていてもリクエストはそのまま子プロセスに転送される。再接続中に届いたメッセージはキューに保持される (最大 500 件。満杯になると最も古いものが破棄され、破棄されたリクエストには同じエラーが返る)。子プロセスに送信済みのリクエストは、子プロセスが終了すると同じエラーで応答され、副作用がすでに発生している可能性があるため再試行されない。子プロセスが動いていない間に受け取った `initialize` には、子プロセスが復帰した後に応答する。診断ログは stderr に出力され、ブリッジは stdout に MCP の JSON-RPC メッセージのみを書き込む (子プロセスの出力はそのまま転送される)。診断ログでは、URL の認証情報とクエリの値、および passthrough 引数の値はマスクされる。

## ライセンス

MIT
