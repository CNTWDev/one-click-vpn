import SwiftUI

enum NorthstarStyle {
    static let canvas = Color(red:0.97,green:0.96,blue:0.93)
    static let ink = Color(red:0.09,green:0.15,blue:0.19)
    static let muted = Color(red:0.36,green:0.41,blue:0.44)
    static let accent = Color(red:0.0,green:0.48,blue:0.39)
    static let mint = Color(red:0.89,green:0.97,blue:0.94)
}

struct NorthstarButton:ButtonStyle {
    var primary=false
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration:Configuration)->some View {
        configuration.label.font(.headline).frame(maxWidth:.infinity).padding(.vertical,16).padding(.horizontal,18)
            .foregroundStyle(primary ? Color.white:NorthstarStyle.accent)
            .background(primary ? NorthstarStyle.accent:NorthstarStyle.mint,in:RoundedRectangle(cornerRadius:18))
            .opacity(enabled ? (configuration.isPressed ? 0.75:1):0.45)
    }
}

extension View {
    func northstarCard()->some View {
        self.padding(22).frame(maxWidth:.infinity,alignment:.leading)
            .background(.white,in:RoundedRectangle(cornerRadius:26))
            .overlay(RoundedRectangle(cornerRadius:26).stroke(NorthstarStyle.ink.opacity(0.04)))
            .shadow(color:NorthstarStyle.ink.opacity(0.035),radius:16,y:5)
    }
    func northstarField()->some View {
        self.textFieldStyle(.plain).padding(16).frame(minHeight:54)
            .background(.white,in:RoundedRectangle(cornerRadius:16))
            .overlay(RoundedRectangle(cornerRadius:16).stroke(NorthstarStyle.ink.opacity(0.15)))
    }
}
