import Foundation

enum L10n {
    static let preferenceKey = "veilbird.language"
    static var language: String {
        let selected = UserDefaults.standard.string(forKey: preferenceKey) ?? "system"
        if ["en", "zh-Hans", "ru"].contains(selected) { return selected }
        for value in Locale.preferredLanguages {
            let base = value.split(separator: "-").first.map(String.init) ?? "en"
            if base == "zh" { return "zh-Hans" }
            if ["en", "ru"].contains(base) { return base }
        }
        return "en"
    }
    static var locale: Locale { Locale(identifier: language) }
    /// The items of release notes in the app's language. Notes from clients/CHANGELOG.md have "### zh/en/ru" blocks
    /// of "- " items; notes typed in Console without blocks count for every language. English is the fallback.
    static func notes(_ text: String) -> [String] {
        var blocks: [String: [String]] = [:], block = ""
        for raw in text.components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("###") {
                let code = line.dropFirst(3).trimmingCharacters(in: .whitespaces).lowercased()
                if code.count == 2 { block = code; continue }
            }
            var item = line
            for prefix in ["- ", "* ", "• "] where item.hasPrefix(prefix) { item = String(item.dropFirst(prefix.count)) }
            item = item.trimmingCharacters(in: .whitespaces)
            if !item.isEmpty { blocks[block, default: []].append(item) }
        }
        let code = String(language.prefix(2))
        return blocks[code] ?? blocks["en"] ?? blocks[""] ?? []
    }
    static func text(_ key: String, _ arguments: CVarArg...) -> String {
        let bundle = Bundle.main.path(forResource: language, ofType: "lproj").flatMap(Bundle.init(path:)) ?? Bundle.main
        let template = bundle.localizedString(forKey: key, value: nil, table: "Native")
        return String(format: template, locale: locale, arguments: arguments)
    }
    static func number(_ value: Int) -> String { let formatter = NumberFormatter(); formatter.locale = locale; formatter.numberStyle = .decimal; return formatter.string(from: NSNumber(value: value)) ?? String(value) }
    static func date(_ value: String?) -> String {
        guard let value else { return text("no_expiry") }
        let parser = ISO8601DateFormatter(); parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = parser.date(from: value) ?? ISO8601DateFormatter().date(from: value) else { return value }
        let formatter = DateFormatter(); formatter.locale = locale; formatter.dateStyle = .medium; return formatter.string(from: date)
    }
}
