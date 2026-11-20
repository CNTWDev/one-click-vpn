# TrackNothing 客户端更新记录

每次修改 `clients/version.json` 时，在最上面加一节同版本号的记录：几条用户看得懂的改进，中文、英文、俄语各一份。
发布时（CI 或 `npm run release:client`）这一节自动成为「更新说明」；客户端按自己的语言显示，更新横幅显示第一条，点开看全部。
格式固定：`## 版本号`，下面 `### zh` / `### en` / `### ru`，每条以 `- ` 开头。

## 1.0.19

### zh
- 这一版汇总了最近的改进：第一次使用三步上手，连接状态三端统一，连不上时直接说原因并给出解决按钮
- 流量快用完或账号快到期时提前提醒；安卓和 Windows 支持按应用分流
- 更省电、更省内存，启动更快

### en
- This release brings together recent improvements: a three-step first run, the same connection states on every device, and errors that name the cause with a button that fixes it
- Reminders before your traffic or access runs out; per-app routing on Android and Windows
- Lower battery and memory use, and faster startup

### ru
- В этой версии собраны последние улучшения: первый запуск в три шага, одинаковые состояния подключения на всех устройствах и ошибки, которые называют причину и предлагают кнопку для её устранения
- Напоминания, когда трафик или срок подходят к концу; выбор приложений для VPN на Android и Windows
- Меньше расход батареи и памяти, быстрее запуск

## 1.0.18

### zh
- 流量快用完或账号快到期时提前提醒：首页、Mac 菜单栏和 Windows 托盘里的小标题会直接显示“流量快用完”或“即将到期”
- 到期前 7 天、前 1 天和流量剩 10% 时各发一条系统通知；Mac 菜单栏和 Windows 托盘图标上出现一个琥珀色小点，安卓连接中的通知也会显示提醒

### en
- Reminders before your traffic or access runs out: the small titles on the home screen, the Mac menu bar and the Windows tray now say "Traffic running low" or "Ends soon"
- One system notification each 7 days and 1 day before the end and at 10% traffic left; a small amber dot on the Mac menu bar and Windows tray icons, and a line in Android's notification while connected

### ru
- Напоминания, когда трафик или срок подходят к концу: подписи на главном экране, в строке меню Mac и в трее Windows показывают «Трафик заканчивается» или «Скоро закончится»
- Системное уведомление за 7 дней и за 1 день до конца и при остатке 10% трафика; янтарная точка на значке в строке меню Mac и в трее Windows, строка в уведомлении Android при подключении

## 1.0.17

### zh
- 安卓和 Windows 支持按应用分流：在「账户 → 按应用分流」里选择只让部分应用走代理，或让部分应用直连

### en
- Per-app routing on Android and Windows: in Account → Per-app routing, send only some apps through TrackNothing, or let some apps connect directly

### ru
- Выбор приложений на Android и Windows: в «Аккаунт → Приложения в VPN» можно пустить через TrackNothing только некоторые приложения или, наоборот, исключить их

## 1.0.16

### zh
- 第一次打开分三步：登录、选位置（默认自动选择，并列出离你最快的 3 个）、连接；连上之前不显示底部标签栏，每页右上角标着第几步
- 连接状态在安卓、Mac、Windows 上一个样：连接中光弧绕圈、换线路时逐段尝试、断线重连时显示倒计时和第几次、没网时安静等待
- 连不上时直接说原因和下一步，按钮就是解决办法：设备已满去管理设备、位置没响应改用自动、登录过期重新登录、需要更新就立即更新
- Mac 菜单栏和 Windows 托盘图标只有三档：未连接（半亮）、处理中（闪烁）、已连接（全亮）

### en
- First launch takes three steps: sign in, pick a location (Automatic is preselected, with the three fastest for you listed), connect; the tab bar stays hidden until you connect, and each page shows which step you are on
- Connection states look the same on Android, Mac and Windows: an arc circles while connecting, lines are tried one by one when switching, reconnecting shows a countdown and the attempt, and without a network the app waits quietly
- When a connection fails, the app says why and what to do next, and the button does it: manage devices when the device limit is reached, switch to Automatic when a location does not answer, sign in again when the session expired, update when an update is required
- The Mac menu bar and Windows tray icon have three levels: off (half), working (blinking), connected (full)

### ru
- Первый запуск в три шага: вход, выбор локации (по умолчанию «Автоматически», плюс три самые быстрые для вас), подключение; нижние вкладки появляются после подключения, а на каждой странице видно, какой это шаг
- Состояния подключения одинаковы на Android, Mac и Windows: при подключении по кругу бежит дуга, при смене линии они пробуются по очереди, при переподключении видны обратный отсчёт и номер попытки, без сети приложение спокойно ждёт
- Если подключиться не удалось, приложение говорит причину и что делать, а кнопка делает это: управлять устройствами при лимите, перейти на «Автоматически», если локация не отвечает, войти снова, если сессия истекла, обновиться, если требуется обновление
- Значок в строке меню Mac и в трее Windows в трёх видах: не подключено (приглушён), идёт работа (мигает), подключено (ярко)

## 1.0.15

### zh
- 更省电省内存：Windows 关到托盘、最小化或 Mac 只留菜单栏时，界面动画暂停、不再每秒刷新，Windows 会把闲置内存还给系统
- 启动更快：安卓打开页面时不再反复查询系统语言；Windows 版改为预编译，冷启动更快

### en
- Lighter in the background: closed to the Windows tray, minimised, or in the Mac menu bar only, the app pauses its animations and per-second updates, and Windows hands idle memory back
- Faster start: Android no longer looks up the system language for every line on a page, and the Windows app is precompiled for a quicker cold start

### ru
- Экономнее в фоне: в трее Windows, свёрнутым или только в строке меню Mac приложение останавливает анимации и ежесекундные обновления, а Windows возвращает простаивающую память
- Быстрее запуск: Android больше не запрашивает язык системы для каждой строки на странице, а приложение Windows заранее скомпилировано для более быстрого холодного старта

## 1.0.14

### zh
- 安卓更省电：锁屏后后台检查大幅减少，连接正常时只测正在用的线路，授权续期也更少，断网、换网络和亮屏时仍会立即检查和重连

### en
- Lower battery use on Android: far fewer background checks with the screen off, only the line in use is tested while the connection works, and authorization renews less often; losing or changing the network and turning the screen on still check and reconnect at once

### ru
- Меньше расход батареи на Android: при выключенном экране фоновых проверок намного меньше, при рабочем подключении проверяется только используемая линия, авторизация продлевается реже; при потере или смене сети и включении экрана проверка и переподключение по-прежнему сразу

## 1.0.13

### zh
- Mac 菜单栏和 Windows 托盘里直接切换节点：点「连接位置」就地展开节点列表（带延迟），选一个即切换，已连接时自动改连过去，不再打开主窗口
- Windows 托盘右键菜单新增「连接位置」子菜单，自动选择或指定节点一步完成

### en
- Switch locations right from the Mac menu bar and the Windows tray: the location row opens the list with delays in place, and a pick switches at once (moving a running connection) without opening the main window
- The Windows tray menu has a Location submenu: choose Automatic or a location in one step

### ru
- Смена локации прямо из строки меню Mac и трея Windows: строка локации открывает список с задержками на месте, выбор сразу переключает (и переносит текущее подключение), без открытия главного окна
- В меню трея Windows появилось подменю «Локация»: автовыбор или конкретная локация в один шаг

## 1.0.12

### zh
- 连接更快：哪条线路先通就先用，不再等被屏蔽的线路超时；自动选择位置时不再等不通的节点
- 智能分流第一次连接不再等规则下载完，先连上，规则在后台下载好后自动生效

### en
- Faster connecting: the first line that answers is used right away instead of waiting for blocked ones to time out, and automatic location no longer waits for nodes that do not answer
- Smart routing no longer holds the first connection until its rules are downloaded: you connect at once and the rules apply when they arrive

### ru
- Подключение быстрее: используется первая ответившая линия, без ожидания заблокированных, а автовыбор локации больше не ждёт неотвечающие узлы
- Умная маршрутизация больше не задерживает первое подключение до загрузки правил: подключение сразу, правила применятся после загрузки

## 1.0.11

### zh
- Mac 关闭窗口后不再占着程序坞：应用继续在菜单栏运行，点菜单栏图标「打开 TrackNothing」窗口和程序坞图标一起回来；要彻底退出请选「退出」

### en
- On the Mac, closing the window takes TrackNothing out of the Dock: it keeps running in the menu bar, and "Open TrackNothing" there brings back the window and the Dock icon; choose Quit to exit

### ru
- На Mac после закрытия окна TrackNothing пропадает из Dock и продолжает работать в строке меню; «Открыть TrackNothing» там возвращает окно и значок в Dock, для выхода выберите «Выйти»

## 1.0.10

### zh
- Mac 应用内升级：下载完点「安装并重启」，自动退出旧版、替换并重新打开，不用再打开安装包拖拽覆盖
- Mac 窗口去掉系统灰色标题栏，整个窗口都是应用自己的背景
- 第一次连接时先说明要在系统设置里打开网络扩展，并直接带你到那个开关；系统提示里显示的名字改为 TrackNothing

### en
- Mac in-app update: once downloaded, click "Install and Relaunch"; the app quits, replaces itself and reopens, with no installer to drag
- The Mac window drops the grey system title bar; the app's own backdrop fills the whole window
- The first connection explains the network extension switch and takes you straight to it; macOS prompts now say TrackNothing

### ru
- Обновление на Mac внутри приложения: после загрузки нажмите «Установить и перезапустить» — приложение закроется, обновится и откроется снова, без перетаскивания
- Окно на Mac без серой системной строки заголовка: фон приложения занимает всё окно
- При первом подключении приложение объясняет, где включить сетевое расширение, и сразу открывает этот переключатель; в окнах macOS теперь название TrackNothing

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
