using System.Windows;
using System.Windows.Controls;
using System.Text.Json.Nodes;
using System.Windows.Media;
using System.Windows.Automation;
namespace Northstar;
public partial class MainWindow : Window {
    private readonly NativeApi api=new();
    private string page="连接",nodeName="自动选择 · 推荐";
    private bool busy;
    private static Brush Brush(string hex)=>(Brush)new BrushConverter().ConvertFromString(hex)!;
    public MainWindow() {InitializeComponent();api.Origin=api.SavedOrigin;Render();Closed+=(_,_)=>api.Dispose();}
    private void Text(string value,int size=16)=>ContentPanel.Children.Add(new TextBlock {Text=value,FontSize=size,FontWeight=size>=22?FontWeights.Bold:FontWeights.Normal,Foreground=Brush(size>=22?"#182731":"#5B6970"),TextWrapping=TextWrapping.Wrap,Margin=new Thickness(0,8,0,16)});
    private void Card(string title,string detail) {
        var body=new StackPanel();body.Children.Add(new TextBlock {Text=title,FontSize=22,FontWeight=FontWeights.SemiBold,Margin=new Thickness(0,0,0,10)});
        body.Children.Add(new TextBlock {Text=detail,FontSize=15,Foreground=Brush("#5B6970"),LineHeight=24});
        ContentPanel.Children.Add(new Border {Background=Brush("#FFFFFF"),CornerRadius=new CornerRadius(24),Padding=new Thickness(24),Margin=new Thickness(0,8,0,16),Child=body});
    }
    private Button Button(string title,Action action,bool enabled=true) {var button=new Button {Content=title,MinHeight=46,Padding=new Thickness(16,10,16,10),Margin=new Thickness(0,5,0,5),IsEnabled=enabled};button.Click+=(_,_)=>{if(!busy)action();};ContentPanel.Children.Add(button);return button;}
    private async void Work(Func<Task> action) {
        if(busy)return;busy=true;ContentPanel.IsEnabled=false;NavigationPanel.IsEnabled=false;BusyBanner.Visibility=Visibility.Visible;
        try {await action();}
        catch(Exception error) {MessageBox.Show(error is AccessFailure?error.Message:"暂时无法连接服务，请检查网络后重试。","NORTHSTAR");}
        finally {busy=false;ContentPanel.IsEnabled=true;NavigationPanel.IsEnabled=true;BusyBanner.Visibility=Visibility.Collapsed;}
    }
    private void Render() {
        ContentPanel.Children.Clear();NavigationPanel.Children.Clear();Text("✦  NORTHSTAR",22);
        NavigationPanel.Visibility=api.SignedIn?Visibility.Visible:Visibility.Collapsed;
        if(!api.SignedIn) {Login();return;}
        foreach(var name in new[]{"连接","节点","我的"}) {var b=new Button {Content=name,MinHeight=52,Margin=new Thickness(4),Background=Brush(page==name?"#E2F7F0":"#FFFFFF")};AutomationProperties.SetName(b,name+(page==name?"，当前页面":""));b.Click+=(_,_)=>{if(!busy){page=name;Render();}};NavigationPanel.Children.Add(b);}
        if(page=="连接") {
            Text("连接，自在一点。",32);Text("选好位置，剩下的交给 NORTHSTAR。");
            Card("连接尚未开放","Windows 开发版 · VPN 服务仍在接入中");
            Button("连接尚不可用",()=>{},false);
            Text("开发版：Windows 隧道服务尚未集成。本版本可登录、查看节点和管理授权设备，但不能建立 VPN。");
            Card("连接位置",nodeName);Button("更换连接位置  ›",()=>{page="节点";Render();});
        } else if(page=="节点") Work(async()=>{
            Text("你想从哪里连接？",30);Text("选择位置后，返回连接首页。");
            var result=await api.Request("nodes");Button("自动选择 · 推荐",()=>{nodeName="自动选择 · 推荐";page="连接";Render();});
            Text("搜索节点或地区",14);var search=new TextBox {Margin=new Thickness(0,8,0,16)};AutomationProperties.SetName(search,"搜索节点或地区");ContentPanel.Children.Add(search);
            var list=new StackPanel();ContentPanel.Children.Add(list);
            void Filter() {list.Children.Clear();foreach(var node in result["nodes"]!.AsArray()) {var name=node!["name"]!.GetValue<string>();var region=node["region"]?.GetValue<string>()??"";if(!(name+" "+region).Contains(search.Text,StringComparison.OrdinalIgnoreCase))continue;
                var item=new Button {Content=name+(name==nodeName?"  ✓":"  ›"),HorizontalContentAlignment=HorizontalAlignment.Left,Background=Brush(name==nodeName?"#E2F7F0":"#FFFFFF"),Margin=new Thickness(0,0,0,12)};item.Click+=(_,_)=>{nodeName=name;page="连接";Render();};list.Children.Add(item);}
                if(list.Children.Count==0)list.Children.Add(new TextBlock {Text="没有可用的匹配位置，请更换关键词或稍后刷新。",Margin=new Thickness(0,16,0,16)});
            } Filter();search.TextChanged+=(_,_)=>Filter();Button("刷新节点",()=>Render());
        });
        else Work(async()=>{
            Text("我的 NORTHSTAR",30);Text("账号、用量和设备，都在这里。");
            var account=await api.Request("account");Card(account["name"]!.GetValue<string>(),account["email"]!.GetValue<string>()+"\n有效期 · "+(account["expiresAt"]?.GetValue<string>()?.Split('T')[0]??"不限期"));
            var traffic=account["traffic"];Card("近 30 天流量",$"↑ {Bytes(traffic?["uploadBytes"])}    ↓ {Bytes(traffic?["downloadBytes"])}");
            Text($"授权设备   {account["used"]} / {account["limit"]}",22);Text("未满额度时，新设备首次连接会自动加入。",14);
            foreach(var device in account["devices"]!.AsArray()) {
                if(device!["status"]!.GetValue<string>()=="revoked")continue;
                Text(device["name"]!.GetValue<string>()+(device["isCurrent"]!.GetValue<bool>()?" · 本机":""));
                if(device["status"]!.GetValue<string>()=="revoking")Text("解除中，最多约 5 分钟后释放额度。");
                else Button("解除授权",()=>{if(MessageBox.Show("该设备将不能继续连接。确认解除授权？","NORTHSTAR",MessageBoxButton.YesNo)==MessageBoxResult.Yes)Work(async()=>{await api.Action("revoke",new JsonObject {["enrollmentId"]=device["id"]!.GetValue<string>()});page="连接";Render();});});
            }
            Button("刷新设备状态",()=>Render());Button("退出登录",()=>Work(async()=>{await api.Logout();Render();}));
        });
    }
    private void Login() {
        Text("世界很大，\n一点即达。",36);Text("登录 NORTHSTAR，无需导入或配置。");
        Card("随心选择，自在连接","自动选择可用位置，也能自由指定节点。");
        Text("服务地址");var origin=new TextBox {Text=api.Origin,MinHeight=36};ContentPanel.Children.Add(origin);
        Text("邮箱");var email=new TextBox {MinHeight=36};ContentPanel.Children.Add(email);
        Text("密码");var password=new PasswordBox {MinHeight=36};ContentPanel.Children.Add(password);
        AutomationProperties.SetName(origin,"服务地址");AutomationProperties.SetName(email,"邮箱");AutomationProperties.SetName(password,"密码");
        var login=Button("登录并开始",()=>{if(string.IsNullOrWhiteSpace(email.Text)||password.Password.Length==0){MessageBox.Show("请填写邮箱和密码。","NORTHSTAR");return;}Work(async()=>{api.Origin=origin.Text.Trim();await api.Login(email.Text.Trim(),password.Password);password.Clear();page="连接";Render();});});login.Background=Brush("#007A64");login.Foreground=Brush("#FFFFFF");login.IsDefault=true;
    }
    private static string Bytes(JsonNode? value) {double.TryParse(value?.ToString(),out var bytes);string[] units={"B","KB","MB","GB","TB"};var i=0;while(bytes>=1024&&i<units.Length-1){bytes/=1024;i++;}return $"{bytes:0.#} {units[i]}";}
}
