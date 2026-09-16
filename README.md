# 会话用量

PI-Desktop 插件。输入框输入 **`/usage`**，或命令面板搜「用量」，查看**当前会话**的 token 用量。

- 插件 id：`cc.mcii.session-usage`
- 许可证：[GPL-3.0-only](./LICENSE)
- 源码 / 主页：https://github.com/LectWolf/pi-session-usage

## 会显示什么

- 输入（未命中缓存）
- 缓存命中 / **缓存创建**（Claude 的 `cache_creation_input_tokens`，含 5m / 1h）
- 输出、思考
- **命中率** = 缓存命中 /（未命中输入 + 缓存命中 + 缓存创建）
- 最近一轮卡片、按模型拆分（回复次数写成 `128次`）

插件命令拿不到「正在看的会话」API。`/usage` 会优先选**没有正在跑的回合**的最近会话，避免被旁边还在生成的聊天抢走。面板顶部可以手动切换会话；选中后刷新会钉在那个会话上。

## 安装

1. 打开 [Releases](https://github.com/LectWolf/pi-session-usage/releases)，下载最新的 `cc.mcii.session-usage-*.piplug`
2. PI-Desktop → **插件** → **安装 .piplug**
3. 确认权限：只需 `ui.panel`
4. 输入框输入 `/usage` 回车

开发加载：插件页 **加载开发插件**，选本目录。

## 权限与安全说明

| 权限 | 用途 |
| --- | --- |
| `ui.panel` | 打开独立面板 |

只读取本机 `~/.pi-desktop/sessions/<id>.jsonl` 和 `pi.sqlite` 里的用量字段，不读消息正文，不联网，不注册 Agent 工具。安装界面不会单独弹出文件系统授权。

## 开发

```text
python scripts/pack.py
# → dist/cc.mcii.session-usage-<version>.piplug
```

发版：改 `manifest.json` 的 `version`，提交后打标签并推送。

```text
git tag v1.0.0
git push origin v1.0.0
```

GitHub Actions 会核对 tag 与版本号、打 `.piplug`、创建 Release。

需要 PI-Desktop ≥ 0.2.0。
