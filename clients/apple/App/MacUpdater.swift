#if os(macOS)
import AppKit
import Security

/// Installs a downloaded, verified update DMG in place, like most Mac apps: "Install and Relaunch" mounts the image,
/// checks that the app inside is signed by the same team with the same identifier, copies it beside the running app,
/// then a small shell step waits for this app to quit, swaps the two bundles, and opens the new one.
/// Anything unexpected (no signature, a read-only location, a failed mount or copy) returns false so the caller can
/// fall back to opening the DMG.
enum MacUpdater {
    enum Failure:Error {case unsigned,mount,missingApp,signature,copy,launch}

    /// The running app's Team ID, from its own code signature (nil for unsigned development builds).
    static var teamIdentifier:String? {
        var code:SecCode?
        guard SecCodeCopySelf([],&code)==errSecSuccess,let code else {return nil}
        var staticCode:SecStaticCode?
        guard SecCodeCopyStaticCode(code,[],&staticCode)==errSecSuccess,let staticCode else {return nil}
        var info:CFDictionary?
        guard SecCodeCopySigningInformation(staticCode,SecCSFlags(rawValue:kSecCSSigningInformation),&info)==errSecSuccess,
              let values=info as? [String:Any] else {return nil}
        return values[kSecCodeInfoTeamIdentifier as String] as? String
    }

    /// Whether the app can replace itself where it is (an admin user's /Applications, or any writable folder).
    static var canInstall:Bool {
        teamIdentifier != nil && FileManager.default.isWritableFile(atPath:Bundle.main.bundleURL.deletingLastPathComponent().path)
    }

    /// Builds before 1.0.10 ran in the App Sandbox, so their settings (location, routing, kill switch, look) live in
    /// the app's container; the first unsandboxed launch copies them over once.
    static func adoptSandboxDefaults() {
        let defaults=UserDefaults.standard
        guard !defaults.bool(forKey:"sandboxDefaultsAdopted"),let id=Bundle.main.bundleIdentifier,
              ProcessInfo.processInfo.environment["APP_SANDBOX_CONTAINER_ID"]==nil else {return}
        defaults.set(true,forKey:"sandboxDefaultsAdopted")
        let old=FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Containers/\(id)/Data/Library/Preferences/\(id).plist")
        guard let data=try? Data(contentsOf:old),
              let values=(try? PropertyListSerialization.propertyList(from:data,format:nil)) as? [String:Any] else {return}
        for (key,value) in values where defaults.object(forKey:key)==nil && !key.hasPrefix("NS") && !key.hasPrefix("Apple") {defaults.set(value,forKey:key)}
    }

    /// Prepares the new bundle and starts the swap; the caller quits the app right after it returns.
    static func install(dmg:URL) throws {
        guard let team=teamIdentifier,let identifier=Bundle.main.bundleIdentifier else {throw Failure.unsigned}
        let current=Bundle.main.bundleURL
        let folder=current.deletingLastPathComponent()
        let staged=folder.appendingPathComponent(".TrackNothing-update.app")
        let mount=FileManager.default.temporaryDirectory.appendingPathComponent("TrackNothing-mount-\(ProcessInfo.processInfo.processIdentifier)")
        try? FileManager.default.createDirectory(at:mount,withIntermediateDirectories:true)
        guard run("/usr/bin/hdiutil",["attach",dmg.path,"-nobrowse","-readonly","-noautoopen","-noverify","-mountpoint",mount.path])==0 else {throw Failure.mount}
        defer {_=run("/usr/bin/hdiutil",["detach",mount.path,"-force"])}
        let apps=(try? FileManager.default.contentsOfDirectory(at:mount,includingPropertiesForKeys:nil)) ?? []
        guard let app=apps.first(where:{$0.pathExtension=="app"}) else {throw Failure.missingApp}
        try check(app,identifier:identifier,team:team)
        try? FileManager.default.removeItem(at:staged)
        // ditto keeps the signature, extended attributes and symlinks exactly as signed.
        guard run("/usr/bin/ditto",[app.path,staged.path])==0 else {throw Failure.copy}
        try check(staged,identifier:identifier,team:team)
        let script="""
        pid=$1; current=$2; staged=$3
        while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
        # The desktop widget process keeps running from the old bundle and would answer for the new build.
        pkill -f "$current/Contents/PlugIns/" 2>/dev/null
        old="$current.old-$$"
        mv "$current" "$old" && mv "$staged" "$current" || { [ -d "$old" ] && [ ! -d "$current" ] && mv "$old" "$current"; open "$current"; exit 1; }
        rm -rf "$old"
        open "$current"
        """
        let process=Process()
        process.executableURL=URL(fileURLWithPath:"/bin/sh")
        process.arguments=["-c",script,"sh",String(ProcessInfo.processInfo.processIdentifier),current.path,staged.path]
        process.standardOutput=FileHandle.nullDevice;process.standardError=FileHandle.nullDevice
        do {try process.run()} catch {throw Failure.launch}
    }

    /// The new app must carry a valid Developer ID signature from the same team and the same bundle identifier.
    private static func check(_ app:URL,identifier:String,team:String) throws {
        var staticCode:SecStaticCode?
        guard SecStaticCodeCreateWithPath(app as CFURL,[],&staticCode)==errSecSuccess,let staticCode else {throw Failure.signature}
        var requirement:SecRequirement?
        let text="anchor apple generic and identifier \"\(identifier)\" and certificate leaf[subject.OU] = \"\(team)\""
        guard SecRequirementCreateWithString(text as CFString,[],&requirement)==errSecSuccess,let requirement else {throw Failure.signature}
        let flags=SecCSFlags(rawValue:kSecCSCheckAllArchitectures|kSecCSCheckNestedCode|kSecCSStrictValidate)
        guard SecStaticCodeCheckValidity(staticCode,flags,requirement)==errSecSuccess else {throw Failure.signature}
    }

    @discardableResult private static func run(_ tool:String,_ arguments:[String])->Int32 {
        let process=Process()
        process.executableURL=URL(fileURLWithPath:tool)
        process.arguments=arguments
        process.standardOutput=FileHandle.nullDevice;process.standardError=FileHandle.nullDevice
        do {try process.run()} catch {return -1}
        process.waitUntilExit()
        return process.terminationStatus
    }
}
#endif
