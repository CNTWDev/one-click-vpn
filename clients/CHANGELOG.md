# TrackNothing 客户端更新记录

每次修改 `clients/version.json` 时，在最上面加一节同版本号的记录：几条用户看得懂的改进，中文、英文、俄语各一份。
发布时（CI 或 `npm run release:client`）这一节自动成为「更新说明」；客户端按自己的语言显示，更新横幅显示第一条，点开看全部。
格式固定：`## 版本号`，下面 `### zh` / `### en` / `### ru`，每条以 `- ` 开头。

## 1.0.39

### zh
- 电脑上切换「连接 / 位置 / 我的」更顺滑：选中块滑过去，页面淡入淡出，不再卡一下
- 连接时每秒更新的网速和活动数据只刷新显示它们的地方，整个窗口更省电、更跟手
- 各处的分段切换（页面、分流模式、用量范围、活动视图）统一成同一种样式

### en
- Switching between Connect, Locations and Account on the computer is smoother: the highlight slides across and pages fade instead of stuttering
- While connected, the per-second speed and Activity figures now only redraw where they are shown, so the window stays light and responsive
- Every segmented switch (pages, routing mode, usage range, Activity views) now shares one look

### ru
- На компьютере переключение между «Подключение», «Локации» и «Аккаунт» стало плавнее: выделение скользит, страницы плавно сменяются без рывков
- При подключении ежесекундные данные о скорости и «Активности» обновляют только то место, где показаны, поэтому окно работает легче и отзывчивее
- Все переключатели-сегменты (страницы, режим маршрутизации, период использования, виды «Активности») теперь выглядят одинаково

## 1.0.38

### zh
- 在「活动」详情里改走法（代理 / 直连 / 拦截）前会先确认一次，避免误点改掉规则

### en
- Changing how a connection is routed (Proxy / Direct / Block) from Activity now asks you to confirm first, so a stray click can't change your rules

### ru
- Перед сменой маршрута соединения (прокси / напрямую / блокировать) в «Активности» теперь нужно подтверждение, чтобы случайный щелчок не менял правила

## 1.0.37

### zh
- 电脑上「活动」里点一条连接，详情显示在列表右侧，不再盖住列表；选中的那一行一直看得见
- 手机上点一条连接，详情从底部弹出

### en
- On the computer, clicking a connection in Activity shows its details in a column to the right of the list, so nothing is covered and the selected row stays in view
- On the phone, a connection's details open from the bottom

### ru
- На компьютере при щелчке по соединению в «Активности» подробности открываются колонкой справа от списка: ничего не закрыто, выбранная строка остаётся на виду
- На телефоне подробности соединения открываются снизу

## 1.0.36

### zh
- 修复开着 VPN 时微信等国内应用发图片、传文件很慢甚至发不出去：断线检测不再把正在上传的连接当成卡住，也不再顺带掐断直连的国内连接

### en
- Fixed slow or failing photo and file uploads in WeChat and other mainland apps while connected: the stall check no longer mistakes an upload for a hang, and no longer closes direct connections

### ru
- Исправлена медленная или прерывающаяся отправка фото и файлов в WeChat и других китайских приложениях при подключении: проверка зависаний больше не принимает загрузку за зависание и не закрывает прямые соединения

## 1.0.35

### zh
- 「活动」列表在鼠标停在上面时不再重新排序，右键和点击不会点错行
- 点一下连接，下方面板里就有全部操作：总是走加密 / 总是直连 / 屏蔽（可选整个网站或只这个域名）、复制域名、断开连接、去分流规则
- 去掉「高级功能」开关：收藏、协议锁定和分流规则默认都可以用

### en
- The Activity list holds its order while the pointer is on it, so a click or right-click lands on the right row
- Click a connection and the panel below has every action: always encrypt / always direct / block (whole site or just that name), copy the domain, close the connection, open routing rules
- No more Advanced switch: favorites, protocol lock and routing rules are always available

### ru
- Список «Активности» не меняет порядок, пока над ним указатель, поэтому щелчок попадает в нужную строку
- Щёлкните соединение — в панели ниже все действия: всегда через шифрование / всегда напрямую / блокировать (весь сайт или только этот домен), копировать домен, закрыть соединение, открыть правила
- Переключателя «Расширенные функции» больше нет: избранное, фиксация протокола и правила маршрутизации доступны всегда

## 1.0.34

### zh
- 「活动」里右键（手机上长按）随时都能设「总是走加密 / 总是直连 / 屏蔽」，不用先去打开高级功能
- 电脑上「活动」顶部的标签不再被挤成省略号

### en
- Right-click (long press on the phone) in Activity offers Always encrypt / Always direct / Block right away, without turning on Advanced first
- On the computer, the tabs at the top of Activity no longer shrink to an ellipsis

### ru
- Правый щелчок (на телефоне — долгое нажатие) в «Активности» сразу предлагает «Всегда через шифрование / Всегда напрямую / Блокировать», без включения расширенных функций
- На компьютере вкладки вверху «Активности» больше не сжимаются в многоточие

## 1.0.33

### zh
- 「活动」里右键一条连接（手机上长按），就能把这个网站设成总是走加密、总是直连或屏蔽，可选整个网站或只这个域名，马上生效，不用重连
- 点一条连接就能看到「为什么这样走」：命中了哪条规则、走加密还是直连、从哪个位置出去
- 还能复制域名、单独断开一条连接；加了规则可以一键撤销
- 分流规则页保存后也立即生效，不再断开重连

### en
- In Activity, right-click a connection (long press on the phone) to always encrypt, always go direct or block that site, for the whole site or just that name; it applies at once, no reconnect
- Tap a connection to see why it went that way: the rule it matched, encrypted or direct, and the location it left from
- Copy the domain or close a single connection from the same menu; a new rule can be undone in one tap
- Saving the routing rules page now applies at once too, without reconnecting

### ru
- В «Активности» щёлкните соединение правой кнопкой (на телефоне — долгое нажатие), чтобы сайт всегда шёл через шифрование, напрямую или блокировался — весь сайт или только этот домен; применяется сразу, без переподключения
- Нажмите на соединение, чтобы увидеть, почему оно пошло так: какое правило сработало, шифрование или напрямую, через какую локацию
- Там же можно скопировать домен или закрыть одно соединение; новое правило отменяется одним нажатием
- Сохранение правил маршрутизации теперь тоже применяется сразу, без переподключения

## 1.0.32

### zh
- AI 网站（ChatGPT、Claude、Gemini 等）始终走加密通道，智能分流下也一样
- 用过 AI 的话，自动模式不再选 AI 服务不支持的位置（比如香港）
- 自动换位置时，如果正在用 AI，优先换到同一个国家，减少账号因 IP 跳动被风控

### en
- AI sites (ChatGPT, Claude, Gemini and others) always go through the tunnel, smart routing included
- Once you use AI, Automatic no longer picks locations AI services refuse (such as Hong Kong)
- When Automatic has to move while you use AI, it tries the same country first, so your account does not see the IP jump

### ru
- Сайты ИИ (ChatGPT, Claude, Gemini и другие) всегда идут через туннель, в том числе при умной маршрутизации
- Если вы пользуетесь ИИ, режим «Автоматически» не выбирает локации, где сервисы ИИ недоступны (например, Гонконг)
- Когда «Автоматически» меняет локацию во время работы с ИИ, сначала пробует ту же страну, чтобы аккаунт не видел скачков IP

## 1.0.31

### zh
- 「线路体检」里的线路名、延迟和说明文字都能完整显示，不再被截断或挤成两行
- 电脑上点体检面板外面就能关掉，右上角也有关闭按钮
- 体检面板更紧凑，一屏就能看完，「测网速」和「重新检测」并排放在底部

### en
- Connection check now shows line names, delays and notes in full, nothing cut off or squeezed onto two lines
- On the computer, click outside the connection check to close it, or use the close button at its top right
- The check is more compact and fits on one screen, with Test speed and Check again side by side at the bottom

### ru
- В «Проверке связи» названия линий, задержки и пояснения видны полностью, без обрезки и переносов
- На компьютере проверку можно закрыть щелчком вне панели или кнопкой в правом верхнем углу
- Панель стала компактнее и помещается на один экран, «Измерить скорость» и «Проверить снова» стоят рядом внизу

## 1.0.30

### zh
- 连着却没有流量时会自己发现：几秒内关掉卡住的连接，换一条能用的线路，出口 IP 不变
- 自动模式下整个位置都不通时，换到另一个确认能用的位置，不会再换回刚出问题的那个
- 手动选的位置不会被自动换掉，只在这个位置里换线路

### en
- The app now notices when it is connected but nothing comes back: it closes stuck connections and moves to a working line within seconds, keeping the same exit IP
- In Automatic, when a whole location stops working it moves to another one it has checked, and does not go back to the one that failed
- A location you picked yourself is never swapped; only its lines change

### ru
- Приложение замечает, когда подключение есть, а данные не идут: за секунды закрывает зависшие соединения и переходит на рабочую линию, IP выхода тот же
- В режиме «Автоматически», если не работает вся локация, переключается на другую, уже проверенную, и не возвращается к сбойной
- Выбранную вами локацию приложение не меняет — только линии внутри неё

## 1.0.29

### zh
- 首页的点阵球变成了地球：没连接时标出你所在的城市，连上后一条光弧从你这里落到出口城市
- 弧线旁写着出口城市和距离，连上的那一刻出口会亮起来
- 「我的」里可以关掉「在地球上显示我的位置」，位置只按城市估算，只存在这台设备上

### en
- The dot sphere on the home page is now a globe: off, it marks your city; connected, an arc of light runs from you to the exit city
- The exit city and its distance sit by the arc, and the exit lights up the moment you connect
- Account has "Show me on the globe" to leave your city off; it is only a city, worked out coarsely, and stays on this device

### ru
- Точечная сфера на главной стала глобусом: без подключения отмечает ваш город, после подключения световая дуга идёт к городу выхода
- У дуги — город выхода и расстояние, в момент подключения выход загорается
- В «Аккаунте» можно выключить «Показывать меня на глобусе»; место определяется грубо, до города, и хранится только на устройстве

## 1.0.28

### zh
- 打开「高级功能」后，「我的」里多了「分流规则」：每行一条，域名或网段加 direct、proxy 或 block
- 可以直接粘贴 Clash 规则；规则排在智能分流前面，只保存在这台设备上
- 连着的时候保存规则，会自动重连立即生效

### en
- With Advanced on, Account has Routing rules: one per line, a domain or network plus direct, proxy or block
- Clash rules can be pasted as they are; your rules come before smart routing and stay on this device
- Saving rules while connected reconnects so they apply at once

### ru
- При включённых расширенных функциях в «Аккаунте» есть «Правила маршрутизации»: по одному на строку, домен или сеть и direct, proxy или block
- Правила Clash можно вставить как есть; ваши правила идут раньше умного режима и хранятся только на этом устройстве
- Если сохранить правила во время подключения, VPN переподключится и они сразу заработают

## 1.0.27

### zh
- 「我的」里新增「高级功能」开关，默认关闭，新手看不到这些选项
- 打开后可以收藏常用位置，收藏的排在位置列表最上面
- 可以给某个位置锁定一种协议（Hysteria2、REALITY、XHTTP 或 WireGuard）；连接检查里直接显示协议名

### en
- New "Advanced" switch in Account, off by default, so beginners never see these options
- With it on, favorite the locations you use; favorites sit at the top of the list
- Lock a location to one protocol (Hysteria2, REALITY, XHTTP or WireGuard); the connection check shows protocol names

### ru
- В «Аккаунте» появился переключатель «Расширенные функции», по умолчанию выключен, новички этих настроек не видят
- Когда он включён, частые локации можно добавить в избранное, они стоят вверху списка
- Для локации можно выбрать один протокол (Hysteria2, REALITY, XHTTP или WireGuard); проверка соединения показывает названия протоколов

## 1.0.26

### zh
- 电脑可以扫码登录：Mac、Windows 和网页 Portal 的登录页显示二维码，用已登录的手机 App 在「我的 → 扫码登录电脑」里扫一下并确认即可
- 确认前手机会显示是哪台电脑、在哪里，以及是否会占用设备名额；二维码 2 分钟内有效，只能用一次

### en
- Sign in a computer with your phone: Mac, Windows and the Portal show a QR code; scan it in the signed-in phone app (Account → Sign in a computer) and confirm
- Before you confirm, the phone shows which computer it is, where it is and whether it takes a device slot; a code works once, for 2 minutes

### ru
- Вход на компьютере через телефон: Mac, Windows и Portal показывают QR-код; отсканируйте его в приложении на телефоне («Аккаунт» → «Войти на компьютере») и подтвердите
- Перед подтверждением телефон показывает, что это за компьютер, где он и займёт ли он место устройства; код действует 2 минуты и только один раз

## 1.0.25

### zh
- 连不上时直接告诉你卡在哪一步：网络、服务器、线路还是加密通道，并给出该怎么办
- 网络本身上不了网时先说网络的问题，不再误报成服务器故障
- 「发送诊断」一键把这次连接的检查结果发给管理员，并显示编号方便沟通
- 网络拦了 UDP 或 443 端口时自动换线路，连上后会说明改用了什么

### en
- When connecting fails, the app shows which step stopped it (network, server, lines or tunnel) and what to do
- A network with no internet is named as the cause, instead of looking like a server problem
- "Send check" sends this attempt's check to your admin and shows a reference number
- When a network blocks UDP or port 443 the app switches lines on its own, and says which one it used once connected

### ru
- Если подключиться не удалось, приложение показывает, на каком шаге (сеть, сервер, линии или туннель) и что делать
- Если в сети нет интернета, причиной называется сеть, а не сервер
- «Отправить» передаёт проверку этой попытки администратору и показывает номер обращения
- Если сеть блокирует UDP или порт 443, приложение само меняет линию и после подключения сообщает, какую использует

## 1.0.24

### zh
- 连接时更稳：应用会记录每次连接的结果，帮助我们在新版本推给所有人之前先发现问题
- 连不上的服务器会被自动移出列表，恢复后自动放回

### en
- Steadier connections: the app now notes how each connection went, so problems in a new version are caught before it reaches everyone
- Servers nobody can reach are taken out of the list automatically and come back once they recover

### ru
- Стабильнее подключение: приложение отмечает, как прошло каждое подключение, чтобы проблемы новой версии находились до того, как она дойдёт до всех
- Серверы, к которым никто не может подключиться, автоматически убираются из списка и возвращаются после восстановления

## 1.0.23

### zh
- 新增「用量」页：在首页点用量那一行进入，看剩余流量、到期还有几天
- 按 7 / 30 / 90 天看每天用了多少，点某一天的柱子看当天数字
- 看每台设备、每个地区各用了多少；Windows 还能看最近 7 天哪些程序用得最多（只保存在这台电脑上）

### en
- New Usage page: tap the usage line on the home screen to see what is left and how many days remain
- See traffic per day over 7, 30 or 90 days; tap a bar for that day's figure
- See usage per device and per location; on Windows, also which programs used the most over the last 7 days (kept on this computer only)

### ru
- Новая страница «Трафик»: нажмите строку трафика на главном экране, чтобы увидеть остаток и сколько дней осталось
- Трафик по дням за 7, 30 или 90 дней; нажмите столбец, чтобы увидеть цифру за день
- Трафик по устройствам и локациям; в Windows также программы, потратившие больше всего за 7 дней (хранится только на этом компьютере)

## 1.0.22

### zh
- 新用户登录后直接到首页，不用再选地区：默认“自动”，会帮你挑最快的线路，连不上自动换
- 首次使用只剩两步：登录、连接

### en
- New users go straight to the home screen after sign-in, no location step: Automatic is preselected, picks the fastest line and moves on if one fails
- First run is now two steps: sign in, connect

### ru
- После входа новые пользователи сразу попадают на главный экран, без выбора локации: по умолчанию «Автоматически» — самая быстрая линия и переход на другую при сбое
- Первый запуск теперь в два шага: вход и подключение

## 1.0.21

### zh
- Mac 菜单栏和 Windows 托盘弹窗加入常用开关：智能分流、断网保护、登录时启动、菜单栏网速（Mac）/ 按应用分流（Windows），不用打开主窗口
- 连接中在弹窗里切换智能分流或断网保护，会自动重连立即生效
- 弹窗底部可以直接检查更新，结果就显示在那一行

### en
- The Mac menu bar and Windows tray panels now hold the common switches: smart routing, kill switch, open at login, and speed in menu bar (Mac) or per-app routing (Windows), no need to open the window
- Changing smart routing or the kill switch there while connected reconnects and applies at once
- Check for updates right from the panel; the result shows on the same line

### ru
- В панели строки меню Mac и в трее Windows появились частые переключатели: умный режим, блокировка без VPN, автозапуск, скорость в меню (Mac) или выбор приложений (Windows), окно открывать не нужно
- Если сменить там умный режим или блокировку во время подключения, VPN переподключится и изменение сразу вступит в силу
- Проверка обновлений прямо из панели, результат виден в той же строке

## 1.0.20

### zh
- 安卓首页一屏放下：中间的球按屏幕高度自动缩放，任何手机都不用滑动
- 首页更简洁：去掉看不懂的小字，直接告诉你网站能看到的 IP；主按钮改成实底
- 安卓、Mac、Windows 全部去掉描边，卡片和按钮改为柔和的实底；Mac 和 Windows 首页同样精简

### en
- The Android home screen now fits on one screen: the sphere scales with the screen height, so nothing needs scrolling
- A simpler home: no more cryptic small print, just the IP sites can see; the main button is now solid
- No more outlines on Android, Mac or Windows: cards and buttons use soft solid fills, and the Mac and Windows home is simpler too

### ru
- Главный экран Android помещается целиком: шар подстраивается под высоту экрана, прокручивать не нужно
- Главный экран проще: без непонятной мелкой подписи, только IP, который видят сайты; основная кнопка теперь залитая
- На Android, Mac и Windows больше нет рамок: карточки и кнопки с мягкой заливкой, главный экран Mac и Windows тоже проще

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
