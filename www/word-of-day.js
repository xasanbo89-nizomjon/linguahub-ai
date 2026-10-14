// LinguaHub AI - "Word of the day".
//
// A small built-in set of everyday words, each in all five supported
// languages with a short example sentence in each. The word for a given day
// is the same for everyone and needs no network, so the home screen always
// has something to show. For the pair Uzbek -> English the card shows the
// English word, its Uzbek translation and an English example (with the
// Uzbek version of that example). Listening uses the learning language.

var LinguaHubWordOfDay = (function () {
  "use strict";

  // Each entry: the word in every language, and one example sentence in every
  // language ("ex"). The sentences are translations of each other.
  var WORDS = [
    { w: { en: "water", uz: "suv", ar: "ماء", ru: "вода", tr: "su" },
      ex: { en: "I drink a glass of water every morning.", uz: "Men har kuni ertalab bir stakan suv ichaman.", ar: "أشرب كوب ماء كل صباح.", ru: "Каждое утро я пью стакан воды.", tr: "Her sabah bir bardak su içerim." } },
    { w: { en: "friend", uz: "do'st", ar: "صديق", ru: "друг", tr: "arkadaş" },
      ex: { en: "She is my best friend.", uz: "U mening eng yaqin do'stim.", ar: "هي أفضل صديقة لي.", ru: "Она моя лучшая подруга.", tr: "O benim en iyi arkadaşım." } },
    { w: { en: "book", uz: "kitob", ar: "كتاب", ru: "книга", tr: "kitap" },
      ex: { en: "I am reading a good book.", uz: "Men yaxshi kitob o'qiyapman.", ar: "أنا أقرأ كتابًا جيدًا.", ru: "Я читаю хорошую книгу.", tr: "İyi bir kitap okuyorum." } },
    { w: { en: "house", uz: "uy", ar: "بيت", ru: "дом", tr: "ev" },
      ex: { en: "Our house is near the park.", uz: "Bizning uyimiz bog' yaqinida.", ar: "بيتنا قريب من الحديقة.", ru: "Наш дом рядом с парком.", tr: "Evimiz parkın yakınlarında." } },
    { w: { en: "time", uz: "vaqt", ar: "وقت", ru: "время", tr: "zaman" },
      ex: { en: "I don't have time today.", uz: "Bugun vaqtim yo'q.", ar: "ليس لدي وقت اليوم.", ru: "У меня сегодня нет времени.", tr: "Bugün zamanım yok." } },
    { w: { en: "morning", uz: "ertalab", ar: "صباح", ru: "утро", tr: "sabah" },
      ex: { en: "I wake up early in the morning.", uz: "Men ertalab erta uyg'onaman.", ar: "أستيقظ باكرًا في الصباح.", ru: "Я просыпаюсь рано утром.", tr: "Sabah erken uyanırım." } },
    { w: { en: "food", uz: "ovqat", ar: "طعام", ru: "еда", tr: "yemek" },
      ex: { en: "The food here is delicious.", uz: "Bu yerdagi ovqat juda mazali.", ar: "الطعام هنا لذيذ.", ru: "Еда здесь очень вкусная.", tr: "Buradaki yemek çok lezzetli." } },
    { w: { en: "work", uz: "ish", ar: "عمل", ru: "работа", tr: "iş" },
      ex: { en: "My work starts at nine.", uz: "Mening ishim to'qqizda boshlanadi.", ar: "يبدأ عملي في الساعة التاسعة.", ru: "Моя работа начинается в девять.", tr: "İşim dokuzda başlıyor." } },
    { w: { en: "city", uz: "shahar", ar: "مدينة", ru: "город", tr: "şehir" },
      ex: { en: "This city is very beautiful.", uz: "Bu shahar juda chiroyli.", ar: "هذه المدينة جميلة جدًا.", ru: "Этот город очень красивый.", tr: "Bu şehir çok güzel." } },
    { w: { en: "family", uz: "oila", ar: "عائلة", ru: "семья", tr: "aile" },
      ex: { en: "My family lives in Samarkand.", uz: "Mening oilam Samarqandda yashaydi.", ar: "تعيش عائلتي في سمرقند.", ru: "Моя семья живёт в Самарканде.", tr: "Ailem Semerkant'ta yaşıyor." } },
    { w: { en: "learn", uz: "o'rganmoq", ar: "يتعلّم", ru: "учить", tr: "öğrenmek" },
      ex: { en: "I want to learn English.", uz: "Men ingliz tilini o'rganmoqchiman.", ar: "أريد أن أتعلم الإنجليزية.", ru: "Я хочу выучить английский.", tr: "İngilizce öğrenmek istiyorum." } },
    { w: { en: "speak", uz: "gapirmoq", ar: "يتكلم", ru: "говорить", tr: "konuşmak" },
      ex: { en: "Can you speak slowly, please?", uz: "Iltimos, sekinroq gapira olasizmi?", ar: "هل يمكنك أن تتكلم ببطء من فضلك؟", ru: "Вы можете говорить медленнее, пожалуйста?", tr: "Lütfen yavaş konuşabilir misiniz?" } },
    { w: { en: "beautiful", uz: "chiroyli", ar: "جميل", ru: "красивый", tr: "güzel" },
      ex: { en: "What a beautiful day!", uz: "Qanday chiroyli kun!", ar: "يا له من يوم جميل!", ru: "Какой красивый день!", tr: "Ne güzel bir gün!" } },
    { w: { en: "important", uz: "muhim", ar: "مهم", ru: "важный", tr: "önemli" },
      ex: { en: "Sleep is very important.", uz: "Uyqu juda muhim.", ar: "النوم مهم جدًا.", ru: "Сон очень важен.", tr: "Uyku çok önemlidir." } },
    { w: { en: "difficult", uz: "qiyin", ar: "صعب", ru: "трудный", tr: "zor" },
      ex: { en: "This exercise is difficult.", uz: "Bu mashq qiyin.", ar: "هذا التمرين صعب.", ru: "Это упражнение трудное.", tr: "Bu alıştırma zor." } },
    { w: { en: "always", uz: "doim", ar: "دائمًا", ru: "всегда", tr: "her zaman" },
      ex: { en: "She always smiles.", uz: "U doim jilmayadi.", ar: "هي تبتسم دائمًا.", ru: "Она всегда улыбается.", tr: "O her zaman gülümser." } },
    { w: { en: "tomorrow", uz: "ertaga", ar: "غدًا", ru: "завтра", tr: "yarın" },
      ex: { en: "See you tomorrow!", uz: "Ertaga ko'rishamiz!", ar: "أراك غدًا!", ru: "Увидимся завтра!", tr: "Yarın görüşürüz!" } },
    { w: { en: "street", uz: "ko'cha", ar: "شارع", ru: "улица", tr: "sokak" },
      ex: { en: "The street is quiet at night.", uz: "Ko'cha kechasi tinch.", ar: "الشارع هادئ في الليل.", ru: "Ночью на улице тихо.", tr: "Sokak geceleri sessiz." } },
    { w: { en: "market", uz: "bozor", ar: "سوق", ru: "рынок", tr: "pazar" },
      ex: { en: "We buy fruit at the market.", uz: "Biz bozordan meva sotib olamiz.", ar: "نشتري الفاكهة من السوق.", ru: "Мы покупаем фрукты на рынке.", tr: "Meyveyi pazardan alırız." } },
    { w: { en: "weather", uz: "ob-havo", ar: "طقس", ru: "погода", tr: "hava durumu" },
      ex: { en: "The weather is nice today.", uz: "Bugun ob-havo yaxshi.", ar: "الطقس جميل اليوم.", ru: "Сегодня хорошая погода.", tr: "Bugün hava güzel." } },
    { w: { en: "question", uz: "savol", ar: "سؤال", ru: "вопрос", tr: "soru" },
      ex: { en: "I have a question.", uz: "Mening savolim bor.", ar: "لدي سؤال.", ru: "У меня есть вопрос.", tr: "Bir sorum var." } },
    { w: { en: "answer", uz: "javob", ar: "جواب", ru: "ответ", tr: "cevap" },
      ex: { en: "Do you know the answer?", uz: "Javobni bilasizmi?", ar: "هل تعرف الجواب؟", ru: "Вы знаете ответ?", tr: "Cevabı biliyor musun?" } },
    { w: { en: "help", uz: "yordam", ar: "مساعدة", ru: "помощь", tr: "yardım" },
      ex: { en: "Can you help me, please?", uz: "Iltimos, menga yordam bera olasizmi?", ar: "هل يمكنك مساعدتي من فضلك؟", ru: "Вы можете мне помочь, пожалуйста?", tr: "Bana yardım edebilir misiniz?" } },
    { w: { en: "understand", uz: "tushunmoq", ar: "يفهم", ru: "понимать", tr: "anlamak" },
      ex: { en: "I don't understand this word.", uz: "Men bu so'zni tushunmayapman.", ar: "لا أفهم هذه الكلمة.", ru: "Я не понимаю это слово.", tr: "Bu kelimeyi anlamıyorum." } },
    { w: { en: "school", uz: "maktab", ar: "مدرسة", ru: "школа", tr: "okul" },
      ex: { en: "The children walk to school.", uz: "Bolalar maktabga piyoda boradi.", ar: "يمشي الأطفال إلى المدرسة.", ru: "Дети идут в школу пешком.", tr: "Çocuklar okula yürüyerek gider." } },
    { w: { en: "teacher", uz: "o'qituvchi", ar: "معلم", ru: "учитель", tr: "öğretmen" },
      ex: { en: "My teacher is very kind.", uz: "Mening o'qituvchim juda mehribon.", ar: "معلمي لطيف جدًا.", ru: "Мой учитель очень добрый.", tr: "Öğretmenim çok nazik." } },
    { w: { en: "journey", uz: "sayohat", ar: "رحلة", ru: "поездка", tr: "yolculuk" },
      ex: { en: "The journey takes two hours.", uz: "Sayohat ikki soat davom etadi.", ar: "تستغرق الرحلة ساعتين.", ru: "Поездка занимает два часа.", tr: "Yolculuk iki saat sürüyor." } },
    { w: { en: "dream", uz: "orzu", ar: "حلم", ru: "мечта", tr: "hayal" },
      ex: { en: "Learning English is my dream.", uz: "Ingliz tilini o'rganish mening orzuim.", ar: "تعلم الإنجليزية هو حلمي.", ru: "Выучить английский — моя мечта.", tr: "İngilizce öğrenmek benim hayalim." } },
    { w: { en: "healthy", uz: "sog'lom", ar: "صحي", ru: "здоровый", tr: "sağlıklı" },
      ex: { en: "Fruit is healthy food.", uz: "Meva sog'lom ovqat.", ar: "الفاكهة طعام صحي.", ru: "Фрукты — здоровая еда.", tr: "Meyve sağlıklı bir yiyecektir." } },
    { w: { en: "careful", uz: "ehtiyotkor", ar: "حذر", ru: "осторожный", tr: "dikkatli" },
      ex: { en: "Be careful on the road.", uz: "Yo'lda ehtiyot bo'ling.", ar: "كن حذرًا على الطريق.", ru: "Будь осторожен на дороге.", tr: "Yolda dikkatli ol." } }
  ];

  function dayNumber(date) {
    var d = date instanceof Date ? date : new Date();
    // local calendar day count, so the word changes at local midnight
    return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
  }

  // The word for `date` in the pair {from, to}: the word in the LEARNING
  // language (to), its translation in the native language (from) and the
  // example sentence in both. Returns null for an unsupported language.
  function pick(pair, date) {
    if (!pair || !pair.from || !pair.to) return null;
    var entry = WORDS[dayNumber(date) % WORDS.length];
    if (!entry.w[pair.to] || !entry.w[pair.from]) return null;
    return {
      word: entry.w[pair.to],
      translation: entry.w[pair.from],
      example: entry.ex[pair.to],
      exampleTranslation: entry.ex[pair.from],
      wordLang: pair.to,
      translationLang: pair.from,
      partOfSpeech: null,
      key: entry.w.en
    };
  }

  return { WORDS: WORDS, pick: pick, dayNumber: dayNumber };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = LinguaHubWordOfDay;
}

if (typeof window !== "undefined") {
  window.LinguaHubWordOfDay = LinguaHubWordOfDay;
}
