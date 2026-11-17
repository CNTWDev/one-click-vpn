# TrackNothing 客户端更新记录

每次修改 `clients/version.json` 时，在最上面加一节同版本号的记录：几条用户看得懂的改进，中文、英文、俄语各一份。
发布时（CI 或 `npm run release:client`）这一节自动成为「更新说明」；客户端按自己的语言显示，更新横幅显示第一条，点开看全部。
格式固定：`## 版本号`，下面 `### zh` / `### en` / `### ru`，每条以 `- ` 开头。

## 1.0.3

### zh
- 断线后自动重连，不用再手动重新连接
- 没网时不再耗电探测，网络恢复后立刻连上
- 连接中可以直接换位置
- 可以查看每个版本的更新内容

### en
- Reconnects automatically after a drop, no need to connect again
- No battery-draining checks while offline; reconnects as soon as the network is back
- Switch locations while connected
- See what's new in each version

### ru
- Автоматическое переподключение после обрыва связи
- Без лишних проверок и расхода батареи без сети; подключение сразу после её появления
- Смена локации без отключения
- Список изменений каждой версии
