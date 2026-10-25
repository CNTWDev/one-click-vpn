Windows Filtering Platform rules for the Windows app's kill switch ("断网保护"), copied from
wireguard-windows v0.5.3 `tunnel/firewall` (MIT, WireGuard LLC). Changes: the permitted programs are
passed by path (`EnableFirewall(..., apps)`) instead of matching the current service's SID, because the
TrackNothing core runs as a child of the app, not as a service; display names; `luid_windows.go` is ours.

The session is dynamic: Windows removes every rule when the core process exits, so a crash never leaves
the PC offline.
