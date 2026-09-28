export type CountryOption = { code: string; country: string; label: string };
export type RegionPreset = { id: string; group: string; name: string; label: string; code: string };

const COUNTRY_CODES = `AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW`.split(" ");

const englishNames = new Intl.DisplayNames(["en"], { type: "region" });
const chineseNames = new Intl.DisplayNames(["zh-CN"], { type: "region" });

export function countryName(code: string): string {
  const normalized = code.toUpperCase();
  try { return englishNames.of(normalized) || normalized; } catch { return normalized; }
}

export const countryOptions: CountryOption[] = COUNTRY_CODES.map((code) => {
  const country = countryName(code);
  let chinese = country;
  try { chinese = chineseNames.of(code) || country; } catch { /* keep the English fallback */ }
  return { code, country, label: `${chinese} / ${country} (${code})` };
}).sort((left, right) => left.label.localeCompare(right.label, "zh-CN"));

const presets: Array<[group: string, name: string, label: string, code: string]> = [
  ["亚洲", "Beijing", "北京", "CN"], ["亚洲", "Shanghai", "上海", "CN"], ["亚洲", "Shenzhen", "深圳", "CN"],
  ["亚洲", "Hong Kong", "香港", "HK"], ["亚洲", "Taipei", "台北", "TW"], ["亚洲", "Tokyo", "东京", "JP"],
  ["亚洲", "Osaka", "大阪", "JP"], ["亚洲", "Seoul", "首尔", "KR"], ["亚洲", "Singapore", "新加坡", "SG"],
  ["亚洲", "Bangkok", "曼谷", "TH"], ["亚洲", "Kuala Lumpur", "吉隆坡", "MY"], ["亚洲", "Jakarta", "雅加达", "ID"],
  ["亚洲", "Manila", "马尼拉", "PH"], ["亚洲", "Batam", "巴淡岛", "ID"], ["亚洲", "Johor", "柔佛", "MY"], ["亚洲", "Phnom Penh", "金边", "KH"], ["亚洲", "Hanoi", "河内", "VN"], ["亚洲", "Ho Chi Minh City", "胡志明市", "VN"],
  ["亚洲", "Mumbai", "孟买", "IN"], ["亚洲", "Chennai", "金奈", "IN"], ["亚洲", "Bengaluru", "班加罗尔", "IN"],
  ["亚洲", "Guangzhou", "广州", "CN"], ["亚洲", "Hangzhou", "杭州", "CN"], ["亚洲", "Zhangjiakou", "张家口", "CN"],
  ["亚洲", "Qingdao", "青岛", "CN"], ["亚洲", "Chengdu", "成都", "CN"], ["亚洲", "Nanjing", "南京", "CN"],
  ["亚洲", "Hohhot", "呼和浩特", "CN"], ["亚洲", "Ulanqab", "乌兰察布", "CN"], ["亚洲", "Chongqing", "重庆", "CN"],
  ["亚洲", "Macau", "澳门", "MO"], ["亚洲", "Changhua", "彰化", "TW"], ["亚洲", "Busan", "釜山", "KR"],
  ["亚洲", "Hyderabad", "海得拉巴", "IN"], ["亚洲", "Delhi", "德里", "IN"], ["亚洲", "Pune", "浦那", "IN"],
  ["亚洲", "Almaty", "阿拉木图", "KZ"], ["亚洲", "Ulaanbaatar", "乌兰巴托", "MN"],
  ["中东", "Dubai", "迪拜", "AE"], ["中东", "Riyadh", "利雅得", "SA"], ["中东", "Tel Aviv", "特拉维夫", "IL"],
  ["中东", "Istanbul", "伊斯坦布尔", "TR"], ["中东", "Doha", "多哈", "QA"], ["中东", "Bahrain", "巴林", "BH"],
  ["中东", "Abu Dhabi", "阿布扎比", "AE"], ["中东", "Jeddah", "吉达", "SA"], ["中东", "Dammam", "达曼", "SA"],
  ["中东", "Kuwait City", "科威特城", "KW"], ["中东", "Muscat", "马斯喀特", "OM"],
  ["欧洲", "London", "伦敦", "GB"], ["欧洲", "Dublin", "都柏林", "IE"], ["欧洲", "Amsterdam", "阿姆斯特丹", "NL"],
  ["欧洲", "Frankfurt", "法兰克福", "DE"], ["欧洲", "Paris", "巴黎", "FR"], ["欧洲", "Madrid", "马德里", "ES"],
  ["欧洲", "Lisbon", "里斯本", "PT"], ["欧洲", "Zurich", "苏黎世", "CH"], ["欧洲", "Stockholm", "斯德哥尔摩", "SE"],
  ["欧洲", "Oslo", "奥斯陆", "NO"], ["欧洲", "Copenhagen", "哥本哈根", "DK"], ["欧洲", "Helsinki", "赫尔辛基", "FI"],
  ["欧洲", "Warsaw", "华沙", "PL"], ["欧洲", "Prague", "布拉格", "CZ"], ["欧洲", "Vienna", "维也纳", "AT"],
  ["欧洲", "Milan", "米兰", "IT"], ["欧洲", "Bucharest", "布加勒斯特", "RO"], ["欧洲", "Moscow", "莫斯科", "RU"],
  ["欧洲", "Manchester", "曼彻斯特", "GB"], ["欧洲", "Berlin", "柏林", "DE"], ["欧洲", "Munich", "慕尼黑", "DE"],
  ["欧洲", "Nuremberg", "纽伦堡", "DE"], ["欧洲", "Falkenstein", "法尔肯施泰因", "DE"], ["欧洲", "Marseille", "马赛", "FR"],
  ["欧洲", "Brussels", "布鲁塞尔", "BE"], ["欧洲", "St. Ghislain", "圣吉斯兰", "BE"], ["欧洲", "Eemshaven", "埃姆斯哈文", "NL"],
  ["欧洲", "Luxembourg", "卢森堡", "LU"], ["欧洲", "Geneva", "日内瓦", "CH"], ["欧洲", "Turin", "都灵", "IT"],
  ["欧洲", "Rome", "罗马", "IT"], ["欧洲", "Barcelona", "巴塞罗那", "ES"], ["欧洲", "Aragon", "阿拉贡", "ES"],
  ["欧洲", "Athens", "雅典", "GR"], ["欧洲", "Budapest", "布达佩斯", "HU"], ["欧洲", "Sofia", "索非亚", "BG"],
  ["欧洲", "Belgrade", "贝尔格莱德", "RS"], ["欧洲", "Zagreb", "萨格勒布", "HR"], ["欧洲", "Kyiv", "基辅", "UA"],
  ["欧洲", "Riga", "里加", "LV"], ["欧洲", "Vilnius", "维尔纽斯", "LT"], ["欧洲", "Tallinn", "塔林", "EE"],
  ["欧洲", "Hamina", "哈米纳", "FI"], ["欧洲", "Reykjavik", "雷克雅未克", "IS"], ["欧洲", "Saint Petersburg", "圣彼得堡", "RU"],
  ["北美洲", "Los Angeles", "洛杉矶", "US"], ["北美洲", "San Francisco", "旧金山", "US"], ["北美洲", "Seattle", "西雅图", "US"],
  ["北美洲", "Dallas", "达拉斯", "US"], ["北美洲", "Chicago", "芝加哥", "US"], ["北美洲", "New York", "纽约", "US"],
  ["北美洲", "Miami", "迈阿密", "US"], ["北美洲", "Washington, D.C.", "华盛顿", "US"], ["北美洲", "Toronto", "多伦多", "CA"],
  ["北美洲", "Montreal", "蒙特利尔", "CA"], ["北美洲", "Vancouver", "温哥华", "CA"], ["北美洲", "Mexico City", "墨西哥城", "MX"],
  ["北美洲", "Columbus, Ohio", "俄亥俄州 哥伦布", "US"], ["北美洲", "Ashburn, Virginia", "弗吉尼亚州 阿什本", "US"],
  ["北美洲", "Oregon", "俄勒冈州", "US"], ["北美洲", "Council Bluffs, Iowa", "爱荷华州 康瑟尔布拉夫斯", "US"],
  ["北美洲", "Des Moines, Iowa", "爱荷华州 得梅因", "US"], ["北美洲", "Moncks Corner, South Carolina", "南卡罗来纳州 蒙克斯科纳", "US"],
  ["北美洲", "San Jose", "圣何塞 / 硅谷", "US"], ["北美洲", "Fremont", "弗里蒙特", "US"], ["北美洲", "Las Vegas", "拉斯维加斯", "US"],
  ["北美洲", "Salt Lake City", "盐湖城", "US"], ["北美洲", "Phoenix", "凤凰城", "US"], ["北美洲", "Denver", "丹佛", "US"],
  ["北美洲", "Houston", "休斯顿", "US"], ["北美洲", "San Antonio", "圣安东尼奥", "US"], ["北美洲", "Atlanta", "亚特兰大", "US"],
  ["北美洲", "Boston", "波士顿", "US"], ["北美洲", "Newark, New Jersey", "新泽西州 纽瓦克", "US"], ["北美洲", "Kansas City", "堪萨斯城", "US"],
  ["北美洲", "Honolulu", "檀香山", "US"], ["北美洲", "Calgary", "卡尔加里", "CA"], ["北美洲", "Queretaro", "克雷塔罗", "MX"],
  ["北美洲", "Panama City", "巴拿马城", "PA"],
  ["南美洲", "Sao Paulo", "圣保罗", "BR"], ["南美洲", "Santiago", "圣地亚哥", "CL"], ["南美洲", "Buenos Aires", "布宜诺斯艾利斯", "AR"],
  ["南美洲", "Bogota", "波哥大", "CO"], ["南美洲", "Lima", "利马", "PE"],
  ["南美洲", "Rio de Janeiro", "里约热内卢", "BR"], ["南美洲", "Fortaleza", "福塔莱萨", "BR"], ["南美洲", "Montevideo", "蒙得维的亚", "UY"],
  ["南美洲", "Quito", "基多", "EC"],
  ["大洋洲", "Sydney", "悉尼", "AU"], ["大洋洲", "Melbourne", "墨尔本", "AU"], ["大洋洲", "Perth", "珀斯", "AU"],
  ["大洋洲", "Auckland", "奥克兰", "NZ"], ["大洋洲", "Brisbane", "布里斯班", "AU"], ["大洋洲", "Adelaide", "阿德莱德", "AU"],
  ["大洋洲", "Canberra", "堪培拉", "AU"], ["大洋洲", "Guam", "关岛", "GU"],
  ["非洲", "Johannesburg", "约翰内斯堡", "ZA"], ["非洲", "Cape Town", "开普敦", "ZA"], ["非洲", "Cairo", "开罗", "EG"],
  ["非洲", "Nairobi", "内罗毕", "KE"], ["非洲", "Lagos", "拉各斯", "NG"], ["非洲", "Casablanca", "卡萨布兰卡", "MA"],
  ["非洲", "Accra", "阿克拉", "GH"], ["非洲", "Dakar", "达喀尔", "SN"], ["非洲", "Kigali", "基加利", "RW"],
  ["非洲", "Dar es Salaam", "达累斯萨拉姆", "TZ"], ["非洲", "Tunis", "突尼斯", "TN"], ["非洲", "Algiers", "阿尔及尔", "DZ"],
];

export const regionPresets: RegionPreset[] = presets.map(([group, name, label, code]) => ({
  id: `${code.toLowerCase()}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
  group, name, label: `${label} / ${name} · ${countryName(code)} (${code})`, code,
}));

export const presetGroups = [...new Set(regionPresets.map((item) => item.group))];
