package wfp

import (
	"net"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var procConvertInterfaceIndexToLuid = windows.NewLazySystemDLL("iphlpapi.dll").NewProc("ConvertInterfaceIndexToLuid")

// InterfaceLUID returns the LUID of the network interface called name (the tun mihomo creates).
func InterfaceLUID(name string) (uint64, error) {
	adapter, err := net.InterfaceByName(name)
	if err != nil {
		return 0, err
	}
	var luid uint64
	if status, _, _ := procConvertInterfaceIndexToLuid.Call(uintptr(adapter.Index), uintptr(unsafe.Pointer(&luid))); status != 0 {
		return 0, syscall.Errno(status)
	}
	return luid, nil
}
