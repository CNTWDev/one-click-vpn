# TrackNothing 客户端更新记录

每次修改 `clients/version.json` 时，在最上面加一节同版本号的记录：几条用户看得懂的改进，中文、英文、俄语各一份。
发布时（CI 或 `npm run release:client`）这一节自动成为「更新说明」；客户端按自己的语言显示，更新横幅显示第一条，点开看全部。
格式固定：`## 版本号`，下面 `### zh` / `### en` / `### ru`，每条以 `- ` 开头。

## 1.0.10

### zh
- Mac 应用内升级：下载完点「安装并重启」，自动退出旧版、替换并重新打开，不用再打开安装包拖拽覆盖
- Mac 窗口去掉系统灰色标题栏，整个窗口都是应用自己的背景

### en
- Mac in-app update: once downloaded, click "Install and Relaunch"; the app quits, replaces itself and reopens, with no installer to drag
- The Mac window drops the grey system title bar; the app's own backdrop fills the whole window

### ru
- Обновление на Mac внутри приложения: после загрузки нажмите «Установить и перезапустить» — приложение закроется, обновится и откроется снова, без перетаскивания
- Окно на Mac без серой системной строки заголовка: фон приложения занимает всё окно

## 1.0.9

### zh
- 新 Logo：更粗的 ∅ 圆环和斜杠，大图标用和首页一样的光点填出来；菜单栏、托盘和通知栏也换成新标志

### en
- New logo: a bolder ∅ ring and bar, filled with the same dots as the home page on large icons; the menu bar, tray and notification icons use it too

### ru
- Новый логотип: более толстые кольцо и черта ∅, на больших значках — из тех же точек, что на главном экране; значки в строке меню, трее и уведомлениях тоже новые

## 1.0.8

### zh
- 首页换成「肖像」：你此刻对外暴露的样子是一幅会呼吸的光点画，下面写着出口 IP、设备、时区和语言
- 光点画本身就是开关，中间写着「轻触开始隐身」；隐身后变成一圈光环，环里显示已隐身的时长和网速

### en
- New home "portrait": what you show the world right now is a breathing sphere of light, with your IP, device, time zone and language under it
- The sphere is the switch and says "Tap to hide"; once hidden it turns into a ring showing how long you have been hidden and the speed

### ru
- Новый главный экран «портрет»: то, что о вас сейчас видно, — дышащая сфера из точек света, под ней IP, устройство, часовой пояс и язык
- Сфера и есть переключатель («Нажмите, чтобы скрыться»); после подключения она становится кольцом со временем скрытия и скоростью

## 1.0.7

### zh
- 连接按钮用品牌色描边，一眼就能找到；文字改得更直白：开始隐身 / 停止隐身
- 系统权限（Mac 网络扩展、VPN 配置、安卓 VPN 授权）没允许时，首页会一直提示该去哪里打开，Mac 上一键打开系统设置，允许后自动连接
- 修复安卓：屏幕较高的手机上首页下半部分（连接按钮、线路、流量）不显示也滑不动

### en
- The Connect button now wears the brand colour, so it is the first thing you see; plainer wording (Visible / Hidden)
- When a system permission is missing (Mac network extension, VPN configuration, Android VPN access), the home page keeps saying where to allow it; on the Mac one click opens System Settings, and it connects as soon as you allow it
- Android fix: on tall screens the lower half of the home page (Connect, location, usage) was missing and the page would not scroll

### ru
- Кнопка подключения выделена фирменным цветом, её сразу видно; формулировки стали проще («Видно» / «Скрыто»)
- Если не хватает системного разрешения (сетевое расширение на Mac, конфигурация VPN, доступ к VPN на Android), главная страница подсказывает, где его дать; на Mac настройки открываются одним нажатием, а подключение начинается сразу после разрешения
- Исправление для Android: на высоких экранах нижняя часть главной (кнопка, локация, трафик) не показывалась и страница не прокручивалась

## 1.0.6

### zh
- 首页的连接按钮更醒目，直接写「连接」/「断开连接」，安卓上固定在底部，小屏也不用滑动

### en
- The Connect button on the home page is easier to see, says Connect / Disconnect, and on Android stays at the bottom of the screen on small phones too

### ru
- Кнопка подключения на главной заметнее, называется «Подключиться» / «Отключиться», а на Android всегда видна внизу экрана, даже на маленьких телефонах

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
