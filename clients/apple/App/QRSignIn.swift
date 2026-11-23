#if os(macOS)
import SwiftUI
import CoreImage.CIFilterBuiltins

/// Under the password form on the Mac: a QR the signed-in phone app scans (我的 → 扫码登录电脑) and confirms. Asks every
/// two seconds; a code lives two minutes, then one click makes a new one. Filled card, no outline.
struct QRSignIn:View {
    let start:() async throws -> [String:Any]
    let poll:(String,String) async throws -> String
    let signedIn:() -> Void
    @State private var image:NSImage?
    @State private var status="loading"
    @State private var round=0
    var body:some View {
        Group {
            if status != "unavailable" {
                HStack(spacing:14) {
                    ZStack {
                        RoundedRectangle(cornerRadius:8).fill(Color.white)
                        if let image {Image(nsImage:image).interpolation(.none).resizable().frame(width:104,height:104).opacity(["expired","declined","scanned"].contains(status) ? 0.12:1)}
                        if status == "expired" || status == "declined" {
                            Button(L10n.text("qr_refresh")) {round+=1}.buttonStyle(.plain).font(.system(size:12,weight:.semibold))
                                .foregroundStyle(VeilbirdStyle.onAccent).padding(.horizontal,12).frame(height:28).background(VeilbirdStyle.accent,in:RoundedRectangle(cornerRadius:6))
                        }
                    }.frame(width:112,height:112).accessibilityLabel(Text(L10n.text("qr_sign_in_title")))
                    VStack(alignment:.leading,spacing:4) {
                        Text(L10n.text(title)).font(.system(size:13,weight:.medium)).fixedSize(horizontal:false,vertical:true)
                        Text(L10n.text("qr_sign_in_detail")).font(.system(size:12)).foregroundStyle(VeilbirdStyle.secondary).fixedSize(horizontal:false,vertical:true)
                    }.frame(maxWidth:.infinity,alignment:.leading)
                }.padding(12).background(VeilbirdStyle.surface,in:RoundedRectangle(cornerRadius:VeilbirdStyle.radius))
            }
        }.task(id:round) {await run()}
    }
    private var title:String {
        switch status {
        case "scanned":return "qr_scanned"
        case "expired":return "qr_code_expired"
        case "declined":return "qr_declined"
        default:return "qr_sign_in_title"
        }
    }
    private func run() async {
        status="loading";image=nil
        guard let created=try? await start(),let id=created["id"] as? String,let secret=created["secret"] as? String,let text=created["qr"] as? String else {status="unavailable";return}
        image=Self.code(text);status="pending"
        let until=Date().addingTimeInterval(Double(created["ttl"] as? Int ?? 120))
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds:2_000_000_000)
            if Task.isCancelled {return}
            if Date()>until {status="expired";return}
            guard let next=try? await poll(id,secret) else {continue}
            if next == "approved" {signedIn();return}
            status=next
            if next == "expired" || next == "declined" {return}
        }
    }
    private static func code(_ text:String)->NSImage? {
        let filter=CIFilter.qrCodeGenerator()
        filter.message=Data(text.utf8);filter.correctionLevel="M"
        guard let output=filter.outputImage?.transformed(by:CGAffineTransform(scaleX:8,y:8)),let cg=CIContext().createCGImage(output,from:output.extent) else {return nil}
        return NSImage(cgImage:cg,size:NSSize(width:output.extent.width/2,height:output.extent.height/2))
    }
}
#endif
