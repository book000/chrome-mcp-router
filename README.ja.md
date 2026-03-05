# chrome-mcp-router

[chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) のプロキシラッパー。自動再接続とプロジェクトベースの設定機能を追加します。

- **自動再接続**: Chrome のクラッシュを検知し、Chrome が再起動したら自動的に子プロセスを再起動する
- **プロジェクトルーティング**: ポート番号を直接指定する代わりに、プロジェクト名で Chrome のデバッグ URL を解決できる

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
| `--project <name>` | 設定ファイルのプロジェクト名で `browserUrl` を解決する |
| `--browserUrl <url>` | Chrome のデバッグ URL を直接指定する (例: `http://127.0.0.1:9222`) |

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
2. `chrome-devtools-mcp` を子プロセスとして起動し、stdio を双方向にプロキシする
3. Chrome の `/json/version` エンドポイントを 3 秒ごとにポーリングして生存確認する
4. Chrome がクラッシュ後に再起動したことを検知すると、古い子プロセスを停止して新しく起動し、MCP handshake を再送してセッションを透過的に復元する

## ライセンス

MIT
