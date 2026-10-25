import Foundation
import NetworkExtension

// The Mac tunnel runs as a system extension: its own process, started by macOS, that hands itself to
// NetworkExtension, which then creates PacketTunnelProvider (named in Info.plist) for each connection.
autoreleasepool {NEProvider.startSystemExtensionMode()}
dispatchMain()
