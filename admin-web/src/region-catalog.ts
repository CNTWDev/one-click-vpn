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
  ["亚洲", "Manila", "马尼拉", "PH"], ["亚洲", "Hanoi", "河内", "VN"], ["亚洲", "Ho Chi Minh City", "胡志明市", "VN"],
  ["亚洲", "Mumbai", "孟买", "IN"], ["亚洲", "Chennai", "金奈", "IN"], ["亚洲", "Bengaluru", "班加罗尔", "IN"],
  ["中东", "Dubai", "迪拜", "AE"], ["中东", "Riyadh", "利雅得", "SA"], ["中东", "Tel Aviv", "特拉维夫", "IL"],
  ["中东", "Istanbul", "伊斯坦布尔", "TR"], ["中东", "Doha", "多哈", "QA"], ["中东", "Bahrain", "巴林", "BH"],
  ["欧洲", "London", "伦敦", "GB"], ["欧洲", "Dublin", "都柏林", "IE"], ["欧洲", "Amsterdam", "阿姆斯特丹", "NL"],
  ["欧洲", "Frankfurt", "法兰克福", "DE"], ["欧洲", "Paris", "巴黎", "FR"], ["欧洲", "Madrid", "马德里", "ES"],
  ["欧洲", "Lisbon", "里斯本", "PT"], ["欧洲", "Zurich", "苏黎世", "CH"], ["欧洲", "Stockholm", "斯德哥尔摩", "SE"],
  ["欧洲", "Oslo", "奥斯陆", "NO"], ["欧洲", "Copenhagen", "哥本哈根", "DK"], ["欧洲", "Helsinki", "赫尔辛基", "FI"],
  ["欧洲", "Warsaw", "华沙", "PL"], ["欧洲", "Prague", "布拉格", "CZ"], ["欧洲", "Vienna", "维也纳", "AT"],
  ["欧洲", "Milan", "米兰", "IT"], ["欧洲", "Bucharest", "布加勒斯特", "RO"], ["欧洲", "Moscow", "莫斯科", "RU"],
  ["北美洲", "Los Angeles", "洛杉矶", "US"], ["北美洲", "San Francisco", "旧金山", "US"], ["北美洲", "Seattle", "西雅图", "US"],
  ["北美洲", "Dallas", "达拉斯", "US"], ["北美洲", "Chicago", "芝加哥", "US"], ["北美洲", "New York", "纽约", "US"],
  ["北美洲", "Miami", "迈阿密", "US"], ["北美洲", "Washington, D.C.", "华盛顿", "US"], ["北美洲", "Toronto", "多伦多", "CA"],
  ["北美洲", "Montreal", "蒙特利尔", "CA"], ["北美洲", "Vancouver", "温哥华", "CA"], ["北美洲", "Mexico City", "墨西哥城", "MX"],
  ["南美洲", "Sao Paulo", "圣保罗", "BR"], ["南美洲", "Santiago", "圣地亚哥", "CL"], ["南美洲", "Buenos Aires", "布宜诺斯艾利斯", "AR"],
  ["南美洲", "Bogota", "波哥大", "CO"], ["南美洲", "Lima", "利马", "PE"],
  ["大洋洲", "Sydney", "悉尼", "AU"], ["大洋洲", "Melbourne", "墨尔本", "AU"], ["大洋洲", "Perth", "珀斯", "AU"],
  ["大洋洲", "Auckland", "奥克兰", "NZ"],
  ["非洲", "Johannesburg", "约翰内斯堡", "ZA"], ["非洲", "Cape Town", "开普敦", "ZA"], ["非洲", "Cairo", "开罗", "EG"],
  ["非洲", "Nairobi", "内罗毕", "KE"], ["非洲", "Lagos", "拉各斯", "NG"], ["非洲", "Casablanca", "卡萨布兰卡", "MA"],
];

export const regionPresets: RegionPreset[] = presets.map(([group, name, label, code]) => ({
  id: `${code.toLowerCase()}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
  group, name, label: `${label} / ${name} · ${countryName(code)} (${code})`, code,
}));

export const presetGroups = [...new Set(regionPresets.map((item) => item.group))];
