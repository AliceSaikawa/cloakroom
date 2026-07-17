// Static data used by the built-in heuristic NER (src/heuristicNer.ts). No runtime
// dependencies, no network calls — this module only holds plain string arrays so it
// can run without Ollama or any other external service.

// Common Japanese surnames (kanji), roughly ordered by real-world frequency. Every
// entry here is a surname the author is confident is genuinely in common use; the
// list intentionally stops short of the "400-500" target mentioned in the design
// rather than padding it with unverified names (see task report for this deviation).
export const SURNAMES_JA: readonly string[] = [
  '佐藤', '鈴木', '高橋', '田中', '伊藤', '渡辺', '山本', '中村', '小林', '加藤',
  '吉田', '山田', '佐々木', '山口', '松本', '井上', '木村', '林', '斎藤', '清水',
  '山崎', '阿部', '森', '池田', '橋本', '山下', '石川', '中島', '前田', '藤田',
  '小川', '岡田', '後藤', '長谷川', '村上', '近藤', '石井', '坂本', '遠藤', '青木',
  '藤井', '西村', '福田', '太田', '三浦', '岡本', '松田', '中川', '中野', '原田',
  '小野', '田村', '竹内', '金子', '和田', '中山', '石田', '上田', '森田', '小島',
  '柴田', '原', '宮崎', '酒井', '工藤', '横山', '宮本', '内田', '高木', '谷口',
  '増田', '河野', '田口', '大野', '木下', '丸山', '今井', '高田', '藤原', '安藤',
  '島田', '桜井', '千葉', '平野', '菅原', '久保', '松井', '野口', '佐野', '藤本',
  '上野', '杉山', '岩崎', '岡崎', '松尾', '竹田', '服部', '中西', '宮田', '村田',
  '秋山', '望月', '荒木', '大塚', '小山', '川口', '新井', '森本', '石原', '平田',
  '三宅', '大西', '星野', '川崎', '吉川', '山内', '五十嵐', '西田', '森山', '高野',
  '渡部', '平井', '菊地', '菊池', '三上', '川上', '今村', '川村', '大川', '大石',
  '小松', '小田', '小池', '沢田', '河合', '飯田', '飯塚', '富田', '冨田', '塚本',
  '宮沢', '宮下', '宮川', '石橋', '石黒', '内藤', '江口', '遠山', '岡野', '荻野',
  '荻原', '奥田', '奥村', '小笠原', '小沢', '小澤', '加納', '香川', '片山', '金井',
  '金田', '亀井', '川端', '川原', '神谷', '岸', '岸本', '北村', '桐生', '金城',
  '久米', '久保田', '熊谷', '栗原', '黒田', '児玉', '小西', '榊原', '坂井', '坂口',
  '相良', '佐久間', '佐竹', '塩田', '重松', '篠原', '柴崎', '島崎', '島村', '下田',
  '下村', '白井', '白石', '菅野', '杉本', '杉浦', '須藤', '関', '関口', '高崎',
  '高瀬', '高原', '高松', '高山', '竹中', '竹本', '田代', '田島', '田辺', '谷',
  '谷川', '玉井', '塚田', '津田', '土屋', '出口', '寺田', '寺西', '東', '徳田',
  '戸田', '富永', '中尾', '中沢', '中田', '中原', '長野', '名和', '難波', '西尾',
  '西岡', '西川', '西原', '沼田', '野中', '野村', '萩原', '長谷部', '畑', '花田',
  '浜田', '早川', '原口', '平岡', '平山', '広瀬', '深田', '福井', '福島', '福本',
  '藤崎', '藤山', '星', '細川', '堀', '堀内', '堀田', '本田', '前川', '前野',
  '牧野', '松岡', '松浦', '松崎', '松永', '松原', '松村', '松山', '三木', '水野',
  '水谷', '三谷', '宮城', '宮地', '村井', '村瀬', '村松', '森岡', '森川', '森下',
  '矢野', '柳田', '山岡', '山川', '山中', '山根', '山村', '湯浅', '横田', '横井',
  '吉岡', '吉村', '吉野', '若林', '和泉', '大場', '小関', '石塚', '梶原', '桑原',
  '古川', '古賀', '馬場', '浅野', '浅井', '伊東', '梅田', '梅原', '岩本', '岩井',
  '小坂', '大橋', '大森', '大谷', '大久保', '加瀬', '亀山', '神田', '神山', '喜多',
  '楠木', '黒岩', '沢井', '篠田', '島袋', '清野', '関根', '園田', '泉', '高安',
  '滝沢', '竹村', '武田', '立花', '丹羽', '土井', '富岡', '永井', '長尾', '永田',
  '中込', '那須', '新田', '野田', '芳賀', '浜口', '姫野', '広田', '深沢', '福永',
  '藤代', '古田', '細谷', '前園', '松下', '間宮', '宮嶋', '村岡', '茂木', '森島',
  '矢田', '安田', '柳原', '山形', '山際', '結城', '吉沢', '米田',
]

// Hepburn romanizations of the most frequent surnames above (lowercase; compare
// against `word.toLowerCase()` at call sites). Not a 1:1 mapping to SURNAMES_JA —
// this is a lookup set, so a handful of kanji entries share a romanized form.
export const SURNAMES_ROMAJI: readonly string[] = [
  'sato', 'suzuki', 'takahashi', 'tanaka', 'ito', 'watanabe', 'yamamoto', 'nakamura',
  'kobayashi', 'kato', 'yoshida', 'yamada', 'sasaki', 'yamaguchi', 'matsumoto', 'inoue',
  'kimura', 'hayashi', 'saito', 'shimizu', 'yamazaki', 'abe', 'mori', 'ikeda',
  'hashimoto', 'yamashita', 'ishikawa', 'nakajima', 'maeda', 'fujita', 'ogawa', 'okada',
  'goto', 'hasegawa', 'murakami', 'kondo', 'ishii', 'sakamoto', 'endo', 'aoki',
  'fujii', 'nishimura', 'fukuda', 'ota', 'miura', 'okamoto', 'matsuda', 'nakagawa',
  'nakano', 'harada', 'ono', 'tamura', 'takeuchi', 'kaneko', 'wada', 'nakayama',
  'ishida', 'ueda', 'morita', 'kojima', 'shibata', 'hara', 'miyazaki', 'sakai',
  'kudo', 'yokoyama', 'miyamoto', 'uchida', 'takagi', 'taniguchi', 'masuda', 'kono',
  'taguchi', 'ohno', 'kinoshita', 'maruyama', 'imai', 'takada', 'fujiwara', 'ando',
  'shimada', 'sakurai', 'chiba', 'hirano', 'sugawara', 'kubo', 'matsui', 'noguchi',
  'sano', 'fujimoto', 'ueno', 'sugiyama', 'iwasaki', 'okazaki', 'matsuo', 'takeda',
  'hattori', 'nakanishi', 'miyata', 'murata', 'akiyama', 'mochizuki', 'araki', 'otsuka',
  'koyama',
]

export const HONORIFICS: readonly string[] = [
  'さん', 'さま', '様', '氏', '君', 'くん', 'ちゃん', '先生', '殿',
  '部長', '課長', '係長', '社長', '専務', '常務', '主任', '教授', '監督', '選手',
]

// Words that legitimately precede an honorific but are not a person's surname.
// Kept as full literal strings (including any leading hiragana, e.g. お客/ご主人)
// so the lookup can check the text immediately before the honorific verbatim.
export const NON_NAME_BEFORE_HONORIFIC: readonly string[] = [
  '皆', 'みな', 'お客', 'お母', 'お父', 'お姉', 'お兄', '奥', '嫁', '娘', '息子', '坊',
  '神', '仏', '王', '職人', '店員', '駅員', '看護師', '患者', '大家', 'ご主人',
  'おじい', 'おばあ', '兄', '姉', '母', '父',
]

export const ORG_LEGAL_FORMS: readonly string[] = [
  '株式会社', '有限会社', '合同会社', '合資会社', '合名会社',
  '一般社団法人', '一般財団法人', '公益社団法人', '公益財団法人',
  '特定非営利活動法人', 'NPO法人', '学校法人', '医療法人', '社会福祉法人', '宗教法人',
  '(株)', '(有)', '㈱', '㈲',
]

export const SCHOOL_SUFFIXES: readonly string[] = [
  '大学院大学', '大学', '短期大学', '高等専門学校', '高等学校', '高校',
  '中学校', '小学校', '専門学校', '学園', '学院', '幼稚園', '保育園',
]

export const GENERIC_SCHOOL_PREFIXES: readonly string[] = [
  '国立', '私立', '公立', '有名', '某', '地元', '都内', '近所', '志望',
]
