# TrackNothing 客户端更新记录

每次修改 `clients/version.json` 时，在最上面加一节同版本号的记录：几条用户看得懂的改进，中文、英文、俄语各一份。
发布时（CI 或 `npm run release:client`）这一节自动成为「更新说明」；客户端按自己的语言显示，更新横幅显示第一条，点开看全部。
格式固定：`## 版本号`，下面 `### zh` / `### en` / `### ru`，每条以 `- ` 开头。

## 1.0.6

### zh
- 首页的连接按钮更醒目，直接写「连接」/「断开连接」

### en
- The Connect button on the home page is easier to see and now says Connect / Disconnect

### ru
- Кнопка подключения на главной заметнее и теперь называется «Подключиться» / «Отключиться»

## 1.0.5

### zh
- 新外观「月晕」：珍珠白到玫瑰粉的柔光，登录页右上角或「我的 › 外观」随时切换

### en
- New look, Moon halo: soft pearl to rose light; switch it on the sign-in screen (top right) or in Account › Appearance

### ru
- Новое оформление «Лунный ореол»: мягкий свет от жемчужного до розового; переключается на экране входа (вверху справа) или в разделе «Аккаунт › Оформление»

## 1.0.4

### zh
- 全新外观：每一页都像一份档案，暖黑底色、琥珀色光
- 连接时，一道光扫过首页，你的出口 IP、设备、时区和语言逐行封存；断开时再逐行解封
- 「我的」里邮箱默认加密显示，按住即可查看

### en
- A new look: every page is a sheet in a file, warm black with amber light
- Connecting sends a line of light down the home page and seals your public IP, device, time zone and language line by line; disconnecting opens them again
- Your email is hidden on the account page; press and hold to see it

### ru
- Новый облик: каждая страница как лист досье, тёплый чёрный и янтарный свет
- При подключении полоса света проходит по главной и строка за строкой скрывает ваш IP, устройство, часовой пояс и язык; при отключении всё открывается снова
- Почта на странице аккаунта скрыта; удерживайте, чтобы увидеть

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
