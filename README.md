# chrome-devtools-mcp-bridge

[chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) を橋渡しするブリッジツール。

Chrome がクラッシュした際に自動的に子プロセスを再起動し、MCP 接続を復元します。
また、プロジェクト名でポート番号を解決できるよう設定ファイルをサポートします。

## インストール

```bash
# npx で実行（インストール不要）
npx -y chrome-devtools-mcp-bridge@latest --project myproject
```

## 使い方

### .mcp.json の設定

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp-bridge@latest", "--project", "myproject"]
    }
  }
}
```

### CLI オプション

```
chrome-devtools-mcp-bridge --project <name>
chrome-devtools-mcp-bridge --browserUrl <url>
```

| オプション | 説明 |
| --- | --- |
| `--project <name>` | 設定ファイルのプロジェクト名で `browserUrl` を解決する |
| `--browserUrl <url>` | Chrome のデバッグ URL を直接指定する (例: `http://127.0.0.1:9222`) |

その他のフラグ (`--slim`, `--no-usage-statistics` など) は `chrome-devtools-mcp` に pass-through されます。

### 設定ファイル

`~/.config/chrome-devtools-mcp-bridge/config.json` にプロジェクト名と URL のマッピングを記述します。

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
4. Chrome がクラッシュ後に再起動したことを検知すると、子プロセスを再起動し MCP handshake を再送する

## ライセンス

MIT
