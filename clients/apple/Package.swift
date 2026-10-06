// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "VeilbirdCore",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [.library(name: "VeilbirdCore", targets: ["VeilbirdCore"])],
    targets: [
        .target(name: "VeilbirdCore"),
        .testTarget(name: "VeilbirdCoreTests", dependencies: ["VeilbirdCore"])
    ]
)
