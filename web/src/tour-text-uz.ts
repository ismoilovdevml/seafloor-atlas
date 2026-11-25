// Uzbek (Latin) words for the guided tour, same shape and the same numbers as tour-text-en.ts
// (test/tour.test.ts checks that every chapter quotes exactly the English numbers). Control names stay in
// English in quotes because the rest of the interface is English; source lines are citations and stay English.
import type { TourText } from './tour-model';
import { TEXT_EN } from './tour-text-en';

const src = (id: string) => TEXT_EN.chapters[id].source;

export const TEXT_UZ: TourText = {
  lang: 'uz',
  ui: {
    region: 'Yoʻl-yoʻriqli sayohat',
    start: 'Sayohat',
    exit: 'Sayohatdan chiqish',
    back: 'Orqaga',
    next: 'Keyingi',
    finish: 'Tugatish',
    pause: 'Pauza',
    play: 'Davom etish',
    voiceOn: 'Ovozli oʻqishni toʻxtatish',
    voiceOff: 'Ovoz chiqarib oʻqish',
    chapters: 'Boblar',
    count: (n, total) => `${n} / ${total}`,
    chapter: (n, title) => `${n}-bob: ${title}`,
    paused: 'Pauzada',
    sourcePrefix: 'Manba: ',
    keys: 'Chap va oʻng strelkalar: orqaga va oldinga. Probel: pauza yoki davom. Esc: chiqish.',
    language: 'Sayohat tili',
  },
  chapters: {
    globe: {
      title: 'Butun okean tubi',
      text: 'Salom, men Ping, sizning sonar buyingizman. Bu globus GEBCO 2026 gridi: 361,7 million km² okean, Yer yuzasining 70,9 foizi. Rang chuqurlikni bildiradi: qirgʻoq yonida och yashil, keyin moviy va koʻk, 11 000 m da esa binafsha-qora; sirtga yaqin joyda rang qadamlari zichroq. Butun Yer koʻrinishida tizmalar va botiqlar bilinib tursin deb relyef tik yoʻnalishda choʻzilgan.',
      source: src('globe'),
    },
    measured: {
      title: 'Aslida nima oʻlchangan',
      text: 'Okean tubining faqat 30,8 foizi toʻgʻridan-toʻgʻri oʻlchangan, asosan kema sonari bilan; Seabed 2030 qatʼiyroq qoida bilan GEBCO 2026 uchun 28,7 foiz deb hisoblaydi. “What’s actually measured” qolgan hamma joyni xiralashtiradi: u yerda chuqurlik sunʼiy yoʻldosh gravitatsiyasidan baholangan. Bu yerda MH370 reysini qidirish 2014–2017-yillarda 120 000 km² li yoʻlakni xaritaga tushirgan; u baholangan atrofi fonida yorqin koʻrinadi.',
      source: src('measured'),
    },
    detail: {
      title: 'Toʻliq grid uchun yaqinlashtiring',
      text: 'Uzoqdan xarita gridni 1′ aniqlikda koʻrsatadi. Yaqinlashganda, 6–7 zoomda, toʻliq 15″ gridga oʻtadi va u siz koʻrgan sari yuklanadi; yuklanish chizigʻi jarayonni koʻrsatadi. Monterey kanyoni Grand Kanyon kabi chuqur va Kaliforniya qirgʻogʻidan bir necha yuz metr narida boshlanadi. Bu yerda relyef ×4 choʻzilgan; “Map settings” choʻzishni oʻzgartiradi.',
      source: src('detail'),
    },
    profile: {
      title: 'Challenger Deep orqali kesim',
      text: '“Depth profile” asbobi siz chizgan chiziq boʻylab okean tubini oʻqiydi. Bu chiziq Mariana botigʻini Challenger Deep nuqtasida kesib oʻtadi, bu okeanning maʼlum eng chuqur joyi. Toʻliq aniqlikda gridning u yerdagi eng chuqur katagi 10 927 m, eʼlon qilingan 10 935 m dan 8 m farq qiladi. Panel chiziqning qancha qismini kemalar oʻlchaganini ham koʻrsatadi.',
      source: src('profile'),
    },
    plates: {
      title: 'Plitalar va tizmalar',
      text: '“Plate boundaries” tektonik plitalar tutashgan joylarni harakat turiga qarab ranglaydi: ajralish, subduksiya, transform va toʻqnashuv. Atlantika boʻylab Shimoliy Amerika va Yevrosiyo yiliga taxminan 2 sm uzoqlashadi; Islandiyada tizma ostidagi mantiya issiq nuqtasi uni dengiz sathidan yuqoriga koʻtargan. Chegarani bossangiz, uning ikki plitasi va ularning tezligi chiqadi.',
      source: src('plates'),
    },
    'sea-level': {
      title: 'Muzlik davridagi dengiz',
      text: '“Sea level” asbobi bugungi relyefni suv ostida qoldiradi yoki quruqlikka chiqaradi. −120 m da, taxminan 20 000 yil oldingi soʻnggi muzlik maksimumida, Beringiya Osiyoni Amerikaga ulaydi: dengiz sathidan yuqorida 170,0 million km² quruqlik turadi, bugungidan 21,8 million km² koʻp. Butun oraliqni, −6 000 m dan +100 m gacha, koʻrish uchun play tugmasini bosing.',
      source: src('sea-level'),
    },
    water: {
      title: 'Suv ichida',
      text: '“Ocean water” harorat, shoʻrlik va zichlikni sirtdan 5 000 m gacha 11 ta chuqurlikda va okean tubining oʻzida (shkalaning oxirgi qadami), 1991–2020-yillar oʻrtachasi sifatida koʻrsatadi. Suv ustunini koʻrish uchun okeanni bosing: bu nuqta Tinch okeanining gʻarbida, yuqorisi iliq, termoklin ostida esa sovuq.',
      source: src('water'),
    },
    monsoon: {
      title: 'Shamollar, oqimlar va iyuldagi gullash',
      text: '“Time” panelidagi “Months” rejimi bir nechta qatlamni birga harakatlantiradi. Iyulda Arab dengizi ustida musson janubi-gʻarbdan esadi (yanvarda shimoli-sharqdan) va u ozuqa moddalarni yuqoriga chiqargan Somali va Ummon yaqinida fitoplankton gullaydi. Xlorofill Tinch okeani janubiy aylanmasidagi 0,02 mg/m³ dan Peru apvellingidagi 3 dan ortiqqacha boradi. Ikkinchi oqim qatlami, okean oqimlari, Golfstrim, Kurosio va Agulyasda taxminan 1,3 m/s ga yetadi.',
      source: src('monsoon'),
    },
    quakes: {
      title: 'Zilzilalar va suv osti togʻlari',
      text: '1900-yildan beri magnitudasi 5,5 va undan katta boʻlgan har bir zilzila: kattaligi magnitudaga, rangi chuqurlikka qarab; deyarli hammasi plitalar chegarasida. Halqalar suv osti togʻlari: balandligi kamida 100 m boʻlgan 69 770 ta togʻ; toʻldirilgan halqa choʻqqisida sonar oʻlchovi borligini bildiradi. Tonga botigʻida plitalar yiliga 24 sm gacha yaqinlashadi, bu Yerdagi eng yuqori tezlik.',
      source: src('quakes'),
    },
    human: {
      title: 'Dengizdagi odamlar',
      text: 'Inson faoliyati alohida qatlamlar guruhida. Bu yerda: 2022-yil 14-noyabr holatiga 527 ta internet kabeli va 1 436 ta qirgʻoqqa chiqish nuqtasi, 2015–2021-yillardagi kema joylashuv xabarlaridan olingan kema harakati va Wikidata’dagi choʻkkan kemalar. Neft-gaz platformalari, dengiz osti quvurlari va dengizdagi shamol elektr stansiyalari OpenStreetMap’dan olingan.',
      source: src('human'),
    },
    mapping: {
      title: 'Okean tubini xaritalash, 2019–2026',
      text: '“Time” panelidagi “Years” rejimi GEBCO relizlarini birma-bir koʻrsatadi. Bu atlas hisobiga koʻra GEBCO_2019 da okean tubining 12,4 foizi toʻgʻridan-toʻgʻri oʻlchangan edi, GEBCO_2026 da esa 30,8 foizi. Sariq rang har bir reliz qoʻshgan joyni belgilaydi. Seabed 2030 15% va 28,7% deb eʼlon qilgan: u chuqurlikka bogʻliq gridning kataklarini sanaydi, shuning uchun ikki raqam farq qiladi.',
      source: src('mapping'),
    },
    inspector: {
      title: 'Bitta nuqtada nima maʼlum',
      text: 'Okeanning istalgan nuqtasini bossangiz, nuqta inspektori ochiladi: chuqurlik, shu katakning qancha qismini kemalar oʻlchagani va eng yaqin oʻlchangan okean tubigacha masofa (200 km gacha qidiriladi). Rangi xulosani aytadi: yashil oʻlchanganini, qizil esa 10 km ichida birorta ham oʻlchov yoʻqligini bildiradi. Bu qatlamlar bor joyda SWOT modelining ishonchliligi va ikkinchi model, AUST_2026, qanchalik farq qilishi ham qoʻshiladi. Dengiz sathidan past quruqlik, masalan polder yoki Oʻlik dengiz botigʻi, okean tubi emas, quruqlik deb belgilanadi.',
      source: src('inspector'),
    },
    polar: {
      title: 'Qutblar, haqiqiy relyefi bilan',
      text: 'Web Mercator xarita plitkalari 85,05° da tugaydi, shuning uchun ulardan yasalgan globusda har bir qutb bitta oʻrtacha qiymatli tekis disk boʻlib qoladi. Bu yerda 83° dan qutbgacha boʻlgan haqiqiy GEBCO relyefi alohida qutb diskida, 0,76 km li kataklarda chizilgan: 5 412 m gacha chuqur Arktika okean tubi va narigi chekkada Antarktida muz qatlami. Chuqurlik qutbning oʻzigacha toʻgʻri oʻqiladi, lekin 84,8° dan qutb tomonda kema oʻlchagan ulush baholanmaydi: qamrov gridi shu yerda tugaydi.',
      source: src('polar'),
    },
    amoc: {
      title: 'Atlantika aylanmasi, 26,5° shimoliy kenglikda',
      text: 'Shtrixli chiziq RAPID tizimi: Atlantika boʻylab 26,5° shimoliy kenglikda qoʻyilgan langarli oʻlchov stansiyalari. Ular 2004-yil apreldan beri meridional aylanmani oʻlchab keladi: iliq suv sirtga yaqin shimolga oqadi, uzoq shimolda choʻkadi va chuqurlikda janubga qaytadi; 2024-yil noyabrgacha oʻrtacha har soniyada 17,1 million m³. Kartochkasi uchun chiziqni bosing: oylik yozuv va uning 12 oylik sirpanuvchi oʻrtachasi, hamda yigʻindisi 0 Sv boʻlgan qatʼiy chuqurlik qatlamlari: yuqori 1 100 m da 17,0 Sv shimolga oqadi, xuddi shuncha pastda janubga qaytadi.',
      source: src('amoc'),
    },
    'your-turn': {
      title: 'Endi navbat sizda',
      text: '“Search” 5 412 ta nomlangan suv osti obyekti, kabel va choʻkkan kemani topadi, “Explore” esa 11 ta tayyor koʻrinishni saqlaydi. Manzil satri doim siz koʻrayotgan narsani yozib boradi (hikoya, qatlamlar, dengiz sathi, vaqt, hatto shu sayohat #tour=15 koʻrinishida), shuning uchun havola aynan shu koʻrinishni ulashadi. “About this map” har bir manba va litsenziyani iqtibos uchun DOI bilan sanab beradi. Maroqli sayohat!',
      source: src('your-turn'),
    },
  },
};
