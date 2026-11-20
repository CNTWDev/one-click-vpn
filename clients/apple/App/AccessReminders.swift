import Foundation
import UserNotifications

/// The account's access as the server reports it: state, period end and traffic quota (all nodes together).
/// Running low means 10% of the traffic or 7 days left, as in the reminder mail (server/access-jobs.ts).
struct AccountAccess {
    let state:String, untilText:String?, until:Date?, quota:Int64?, remaining:Int64
    init(_ account:[String:Any]) {
        let access=account["access"] as? [String:Any] ?? [:]
        state=access["state"] as? String ?? "active"
        untilText=access["until"] as? String
        until=untilText.flatMap(Self.parse)
        quota=(access["quotaBytes"] as? NSNumber)?.int64Value
        remaining=(access["remainingBytes"] as? NSNumber)?.int64Value ?? 0
    }
    var low:Bool {
        guard state=="active",let quota else {return false}
        return remaining<=quota/10
    }
    var ending:Bool {
        guard state=="active",let until else {return false}
        return until.timeIntervalSinceNow<=7*86_400
    }
    /// One line for the menu bar panel's tooltip-like places, or nil when nothing is running out.
    var line:String? {
        if low {return L10n.text("reminder_low_line",Self.bytes(remaining))}
        if ending {return L10n.text("reminder_soon_line",L10n.date(untilText))}
        return nil
    }
    static func bytes(_ value:Int64)->String {ByteCountFormatter.string(fromByteCount:value,countStyle:.binary)}
    private static func parse(_ value:String)->Date? {
        let parser=ISO8601DateFormatter();parser.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
        return parser.date(from:value) ?? ISO8601DateFormatter().date(from:value)
    }
}

/// System notifications before the access runs out: once 7 days before the end, once 1 day before, once at 10%
/// traffic left. A step is remembered only while it still holds, so after renewing or adding traffic they start over.
/// Permission is asked the first time there is something to say.
enum AccessReminders {
    private static let key="remindersSent"
    static func check(_ account:[String:Any]) {
        guard !account.isEmpty else {return}
        let access=AccountAccess(account)
        let defaults=UserDefaults.standard
        let saved=Set(defaults.stringArray(forKey:key) ?? [])
        var sent=saved.filter {keep($0,access)}
        var due:[(id:String,title:String,body:String)]=[]
        if access.ending,let end=access.untilText,let until=access.until {
            // Less than a day left when first seen: the 7-day step counts as done, one notification is enough.
            let keys=until.timeIntervalSinceNow<=86_400 ? ["end1:"+end,"end7:"+end]:["end7:"+end]
            if !sent.contains(keys[0]) {
                sent.formUnion(keys)
                due.append(("access-soon",L10n.text("reminder_soon_title"),L10n.text("reminder_soon_body",L10n.date(end))))
            }
        }
        if access.low,let quota=access.quota {
            let id="low:\(quota)"
            if !sent.contains(id) {
                sent.insert(id)
                due.append(("access-low",L10n.text("reminder_low_title"),L10n.text("reminder_low_body",AccountAccess.bytes(access.remaining),AccountAccess.bytes(quota))))
            }
        }
        if sent != saved {defaults.set(Array(sent),forKey:key)}
        guard !due.isEmpty else {return}
        let items=due,center=UNUserNotificationCenter.current()
        center.requestAuthorization(options:[.alert,.sound]) {granted,_ in
            guard granted else {return}
            for item in items {
                let content=UNMutableNotificationContent()
                content.title=item.title;content.body=item.body;content.sound = .default
                center.add(UNNotificationRequest(identifier:item.id,content:content,trigger:nil))
            }
        }
    }
    private static func keep(_ sent:String,_ access:AccountAccess)->Bool {
        if sent.hasPrefix("low:") {return access.low}
        guard access.ending,let end=access.untilText else {return false}
        return sent.hasSuffix(":"+end)
    }
}
