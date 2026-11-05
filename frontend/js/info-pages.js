(function () {
  'use strict';

  var LANGS = [
    ['en', 'English'], ['es', 'Español'], ['de', 'Deutsch'], ['nl', 'Nederlands'], ['hi', 'हिन्दी'],
    ['ar', 'العربية'], ['fr', 'Français'], ['pt', 'Português'], ['ru', 'Русский'], ['ur', 'اردو']
  ];
  var RTL = { ar: 1, ur: 1 };

  // Each language: ui labels, about sections [heading, text], terms sections [heading, [bullets]].
  var T = {
    en: {
      ui: { about: 'About Vynzo', terms: 'Terms & Community Guidelines', back: 'Back', join: 'Create account', login: 'Log in', lang: 'Language', version: 'Version 2026-11-01' },
      intro: 'Vynzo is a social network for sharing your moments with the people you care about. Post, chat, go live and discover new people, all in one place.',
      about: [
        ['Share your moments', 'Publish images and videos, add captions and hashtags, post stories that disappear after 24 hours, and write blog articles. Record a video straight from your camera or edit it with CapCut and upload it.'],
        ['Connect with people', 'Find people, follow them and become friends. Send private messages, see how many unread messages you have, and open Activity to see who liked your posts, stories, videos and blogs, and who followed you.'],
        ['Go live', 'Start a live stream and choose who can watch: everyone, friends or only the friends you select. Invite viewers on camera as guests (up to 12 people including you), use the camera mirror, and chat with your audience in real time.'],
        ['Safe and respectful', 'Vynzo is for adults (18+). Images, videos, stories and live streams are checked automatically. Content with nudity, hate, bullying or other offensive material is removed and the user gets a warning. You can also report content and block people.'],
        ['Your language, your device', 'Vynzo works in 10 languages, including right-to-left languages, on the web and as an Android app. Switch the language at any time.']
      ],
      terms: [
        ['1. Terms & Conditions', ['Age: You must be 18 years old or older to create a Vynzo account. Accounts belonging to anyone under 18 will be removed.', 'Your account: Keep your password secure. You are responsible for activity on your account. Your Vynzo ID is private and must not be shared.', 'Your content: You own what you post, and you give Vynzo permission to store and display it so the service can work. Only post content you have the right to share.', 'Enforcement: Vynzo may remove content, restrict features or suspend accounts that break these rules.', 'Changes: These terms may be updated. Continuing to use Vynzo after an update means you accept the new version.']],
        ['2. Community Guidelines', ['Be respectful. No harassment, threats, hate speech or bullying.', 'No nudity or sexual content, no sexual content involving minors, and no sharing of private images without consent.', 'No violence, graphic abuse, or content that encourages self-harm or illegal activity.', 'No spam, scams, fake accounts or impersonation.', 'Respect copyright and other people\'s privacy. Do not post someone\'s personal information.', 'Use blogs, stories, posts and live streams honestly. Report anything that breaks these rules.']],
        ['3. Regulations and moderation', ['You must follow the laws that apply where you live when using Vynzo.', 'Images, videos, stories and live streams are checked automatically. Content that breaks the rules is deleted, even if it was already uploaded, and you will receive a warning. A live stream that breaks the rules is ended.', 'Illegal content, or content Vynzo is required to remove, will be removed and may be reported to the authorities.', 'You can appeal a moderation decision where an appeal option is offered.']]
      ]
    },
    es: {
      ui: { about: 'Acerca de Vynzo', terms: 'Términos y normas de la comunidad', back: 'Volver', join: 'Crear cuenta', login: 'Iniciar sesión', lang: 'Idioma', version: 'Versión 2026-11-01' },
      intro: 'Vynzo es una red social para compartir tus momentos con las personas que te importan. Publica, chatea, transmite en vivo y descubre gente nueva, todo en un solo lugar.',
      about: [
        ['Comparte tus momentos', 'Publica imágenes y vídeos, añade descripciones y hashtags, sube historias que desaparecen a las 24 horas y escribe artículos de blog. Graba un vídeo con tu cámara o edítalo con CapCut y súbelo.'],
        ['Conecta con la gente', 'Encuentra personas, síguelas y hazte su amigo. Envía mensajes privados, mira cuántos mensajes sin leer tienes y abre Actividad para ver quién dio me gusta a tus publicaciones, historias, vídeos y blogs, y quién te siguió.'],
        ['Transmite en vivo', 'Inicia una transmisión y elige quién puede verla: todos, tus amigos o solo los amigos que selecciones. Invita a espectadores a la cámara como invitados (hasta 12 personas contigo), usa el espejo de cámara y chatea con tu audiencia en tiempo real.'],
        ['Seguro y respetuoso', 'Vynzo es para adultos (18+). Las imágenes, vídeos, historias y transmisiones se revisan automáticamente. El contenido con desnudez, odio, acoso u otro material ofensivo se elimina y el usuario recibe una advertencia. También puedes denunciar contenido y bloquear personas.'],
        ['Tu idioma, tu dispositivo', 'Vynzo funciona en 10 idiomas, incluidos los que se escriben de derecha a izquierda, en la web y como app de Android. Cambia de idioma cuando quieras.']
      ],
      terms: [
        ['1. Términos y condiciones', ['Edad: debes tener 18 años o más para crear una cuenta de Vynzo. Se eliminarán las cuentas de menores de 18 años.', 'Tu cuenta: mantén tu contraseña segura. Eres responsable de la actividad de tu cuenta. Tu ID de Vynzo es privado y no debe compartirse.', 'Tu contenido: lo que publicas es tuyo y das permiso a Vynzo para almacenarlo y mostrarlo para que el servicio funcione. Publica solo contenido que tengas derecho a compartir.', 'Aplicación: Vynzo puede eliminar contenido, limitar funciones o suspender cuentas que incumplan estas normas.', 'Cambios: estos términos pueden actualizarse. Seguir usando Vynzo tras una actualización significa que aceptas la nueva versión.']],
        ['2. Normas de la comunidad', ['Sé respetuoso. Nada de acoso, amenazas, discurso de odio ni intimidación.', 'Nada de desnudos ni contenido sexual, ningún contenido sexual con menores y no compartir imágenes privadas sin consentimiento.', 'Nada de violencia, abuso gráfico ni contenido que incite a la autolesión o a actividades ilegales.', 'Nada de spam, estafas, cuentas falsas ni suplantación de identidad.', 'Respeta los derechos de autor y la privacidad de los demás. No publiques datos personales de otras personas.', 'Usa blogs, historias, publicaciones y transmisiones de forma honesta. Denuncia lo que incumpla estas normas.']],
        ['3. Normativa y moderación', ['Debes cumplir las leyes que se apliquen donde vives al usar Vynzo.', 'Las imágenes, vídeos, historias y transmisiones se revisan automáticamente. El contenido que incumpla las normas se elimina, aunque ya esté subido, y recibirás una advertencia. Una transmisión que incumpla las normas se finaliza.', 'El contenido ilegal, o que Vynzo deba eliminar, se retirará y podrá comunicarse a las autoridades.', 'Puedes apelar una decisión de moderación cuando se ofrezca esa opción.']]
      ]
    },
    de: {
      ui: { about: 'Über Vynzo', terms: 'Nutzungsbedingungen & Community-Richtlinien', back: 'Zurück', join: 'Konto erstellen', login: 'Anmelden', lang: 'Sprache', version: 'Version 2026-11-01' },
      intro: 'Vynzo ist ein soziales Netzwerk, um Momente mit den Menschen zu teilen, die dir wichtig sind. Poste, chatte, geh live und entdecke neue Leute – alles an einem Ort.',
      about: [
        ['Teile deine Momente', 'Veröffentliche Bilder und Videos, füge Beschreibungen und Hashtags hinzu, poste Stories, die nach 24 Stunden verschwinden, und schreibe Blogartikel. Nimm ein Video direkt mit der Kamera auf oder bearbeite es mit CapCut und lade es hoch.'],
        ['Verbinde dich mit Menschen', 'Finde Leute, folge ihnen und werdet Freunde. Sende private Nachrichten, sieh, wie viele ungelesene Nachrichten du hast, und öffne Aktivität, um zu sehen, wer deine Beiträge, Stories, Videos und Blogs geliked hat und wer dir gefolgt ist.'],
        ['Geh live', 'Starte einen Livestream und wähle, wer zusehen darf: alle, Freunde oder nur ausgewählte Freunde. Lade Zuschauer als Gäste auf die Kamera ein (bis zu 12 Personen inklusive dir), nutze den Kameraspiegel und chatte in Echtzeit mit deinem Publikum.'],
        ['Sicher und respektvoll', 'Vynzo ist für Erwachsene (ab 18). Bilder, Videos, Stories und Livestreams werden automatisch geprüft. Inhalte mit Nacktheit, Hass, Mobbing oder anderem anstößigem Material werden entfernt und der Nutzer erhält eine Warnung. Du kannst Inhalte auch melden und Personen blockieren.'],
        ['Deine Sprache, dein Gerät', 'Vynzo funktioniert in 10 Sprachen, auch von rechts nach links, im Web und als Android-App. Wechsle die Sprache jederzeit.']
      ],
      terms: [
        ['1. Nutzungsbedingungen', ['Alter: Du musst mindestens 18 Jahre alt sein, um ein Vynzo-Konto zu erstellen. Konten von Personen unter 18 werden entfernt.', 'Dein Konto: Halte dein Passwort sicher. Du bist für die Aktivität auf deinem Konto verantwortlich. Deine Vynzo-ID ist privat und darf nicht weitergegeben werden.', 'Deine Inhalte: Was du postest, gehört dir; du erlaubst Vynzo, es zu speichern und anzuzeigen, damit der Dienst funktioniert. Poste nur Inhalte, die du teilen darfst.', 'Durchsetzung: Vynzo kann Inhalte entfernen, Funktionen einschränken oder Konten sperren, die gegen diese Regeln verstoßen.', 'Änderungen: Diese Bedingungen können aktualisiert werden. Wenn du Vynzo nach einer Änderung weiter nutzt, akzeptierst du die neue Fassung.']],
        ['2. Community-Richtlinien', ['Sei respektvoll. Keine Belästigung, Drohungen, Hassrede oder Mobbing.', 'Keine Nacktheit oder sexuellen Inhalte, keine sexuellen Inhalte mit Minderjährigen und keine Weitergabe privater Bilder ohne Einwilligung.', 'Keine Gewalt, drastische Misshandlung oder Inhalte, die zu Selbstverletzung oder illegalen Handlungen anregen.', 'Kein Spam, keine Betrugsmaschen, gefälschten Konten oder Identitätsdiebstahl.', 'Respektiere Urheberrechte und die Privatsphäre anderer. Poste keine persönlichen Daten anderer.', 'Nutze Blogs, Stories, Beiträge und Livestreams ehrlich. Melde alles, was gegen diese Regeln verstößt.']],
        ['3. Vorschriften und Moderation', ['Du musst bei der Nutzung von Vynzo die an deinem Wohnort geltenden Gesetze einhalten.', 'Bilder, Videos, Stories und Livestreams werden automatisch geprüft. Regelwidrige Inhalte werden gelöscht, auch wenn sie bereits hochgeladen wurden, und du erhältst eine Warnung. Ein regelwidriger Livestream wird beendet.', 'Illegale Inhalte oder Inhalte, die Vynzo entfernen muss, werden gelöscht und können den Behörden gemeldet werden.', 'Du kannst gegen eine Moderationsentscheidung Einspruch einlegen, wenn eine Einspruchsmöglichkeit angeboten wird.']]
      ]
    },
    nl: {
      ui: { about: 'Over Vynzo', terms: 'Voorwaarden en communityrichtlijnen', back: 'Terug', join: 'Account maken', login: 'Inloggen', lang: 'Taal', version: 'Versie 2026-11-01' },
      intro: 'Vynzo is een sociaal netwerk om je momenten te delen met de mensen die je belangrijk vindt. Post, chat, ga live en ontdek nieuwe mensen, allemaal op één plek.',
      about: [
        ['Deel je momenten', 'Plaats afbeeldingen en video\'s, voeg bijschriften en hashtags toe, post verhalen die na 24 uur verdwijnen en schrijf blogartikelen. Neem een video rechtstreeks met je camera op of bewerk hem met CapCut en upload hem.'],
        ['Maak contact', 'Zoek mensen, volg ze en word vrienden. Stuur privéberichten, zie hoeveel ongelezen berichten je hebt en open Activiteit om te zien wie je berichten, verhalen, video\'s en blogs leuk vond en wie je volgt.'],
        ['Ga live', 'Start een livestream en kies wie mag kijken: iedereen, vrienden of alleen geselecteerde vrienden. Nodig kijkers uit als gast in beeld (tot 12 personen inclusief jou), gebruik de cameraspiegel en chat live met je publiek.'],
        ['Veilig en respectvol', 'Vynzo is voor volwassenen (18+). Afbeeldingen, video\'s, verhalen en livestreams worden automatisch gecontroleerd. Inhoud met naaktheid, haat, pesten of ander aanstootgevend materiaal wordt verwijderd en de gebruiker krijgt een waarschuwing. Je kunt inhoud ook melden en mensen blokkeren.'],
        ['Jouw taal, jouw apparaat', 'Vynzo werkt in 10 talen, ook van rechts naar links, op het web en als Android-app. Wissel op elk moment van taal.']
      ],
      terms: [
        ['1. Algemene voorwaarden', ['Leeftijd: Je moet 18 jaar of ouder zijn om een Vynzo-account te maken. Accounts van personen onder de 18 worden verwijderd.', 'Je account: Houd je wachtwoord veilig. Je bent verantwoordelijk voor de activiteit op je account. Je Vynzo-ID is privé en mag niet worden gedeeld.', 'Je inhoud: Wat je post is van jou en je geeft Vynzo toestemming om het op te slaan en te tonen zodat de dienst werkt. Post alleen inhoud die je mag delen.', 'Handhaving: Vynzo kan inhoud verwijderen, functies beperken of accounts schorsen die deze regels overtreden.', 'Wijzigingen: Deze voorwaarden kunnen worden bijgewerkt. Als je Vynzo na een update blijft gebruiken, accepteer je de nieuwe versie.']],
        ['2. Communityrichtlijnen', ['Wees respectvol. Geen intimidatie, bedreigingen, haatzaaien of pesten.', 'Geen naaktheid of seksuele inhoud, geen seksuele inhoud met minderjarigen en geen privéfoto\'s delen zonder toestemming.', 'Geen geweld, grof misbruik of inhoud die aanzet tot zelfbeschadiging of illegale activiteiten.', 'Geen spam, oplichting, nepaccounts of imitatie.', 'Respecteer auteursrecht en de privacy van anderen. Plaats geen persoonlijke gegevens van anderen.', 'Gebruik blogs, verhalen, berichten en livestreams eerlijk. Meld alles wat deze regels overtreedt.']],
        ['3. Regels en moderatie', ['Je moet de wetten volgen die gelden waar je woont wanneer je Vynzo gebruikt.', 'Afbeeldingen, video\'s, verhalen en livestreams worden automatisch gecontroleerd. Inhoud die de regels overtreedt wordt verwijderd, ook als die al is geüpload, en je ontvangt een waarschuwing. Een livestream die de regels overtreedt wordt beëindigd.', 'Illegale inhoud, of inhoud die Vynzo moet verwijderen, wordt verwijderd en kan worden gemeld aan de autoriteiten.', 'Je kunt in beroep gaan tegen een moderatiebesluit als daar een mogelijkheid voor is.']]
      ]
    },
    hi: {
      ui: { about: 'Vynzo के बारे में', terms: 'नियम और शर्तें व सामुदायिक दिशानिर्देश', back: 'वापस', join: 'खाता बनाएँ', login: 'लॉग इन', lang: 'भाषा', version: 'संस्करण 2026-11-01' },
      intro: 'Vynzo एक सोशल नेटवर्क है जहाँ आप अपने पल उन लोगों के साथ साझा करते हैं जो आपके लिए मायने रखते हैं। पोस्ट करें, चैट करें, लाइव जाएँ और नए लोगों से मिलें, सब एक ही जगह।',
      about: [
        ['अपने पल साझा करें', 'फ़ोटो और वीडियो पोस्ट करें, कैप्शन और हैशटैग जोड़ें, 24 घंटे में गायब होने वाली स्टोरी डालें और ब्लॉग लेख लिखें। कैमरे से सीधे वीडियो रिकॉर्ड करें या CapCut में एडिट करके अपलोड करें।'],
        ['लोगों से जुड़ें', 'लोगों को खोजें, फ़ॉलो करें और दोस्त बनें। निजी संदेश भेजें, अपठित संदेशों की संख्या देखें, और गतिविधि खोलकर देखें कि किसने आपकी पोस्ट, स्टोरी, वीडियो और ब्लॉग को लाइक किया और किसने आपको फ़ॉलो किया।'],
        ['लाइव जाएँ', 'लाइव स्ट्रीम शुरू करें और चुनें कि कौन देख सकता है: सभी, दोस्त या केवल चुने हुए दोस्त। दर्शकों को मेहमान के रूप में कैमरे पर बुलाएँ (आपको मिलाकर 12 लोग तक), कैमरा मिरर इस्तेमाल करें और दर्शकों से रीयल-टाइम में चैट करें।'],
        ['सुरक्षित और सम्मानजनक', 'Vynzo वयस्कों (18+) के लिए है। फ़ोटो, वीडियो, स्टोरी और लाइव स्ट्रीम की अपने-आप जाँच होती है। नग्नता, नफ़रत, बदमाशी या अन्य आपत्तिजनक सामग्री हटा दी जाती है और उपयोगकर्ता को चेतावनी मिलती है। आप सामग्री की रिपोर्ट और लोगों को ब्लॉक भी कर सकते हैं।'],
        ['आपकी भाषा, आपका डिवाइस', 'Vynzo वेब पर और Android ऐप के रूप में 10 भाषाओं में चलता है, दाएँ-से-बाएँ भाषाओं सहित। भाषा कभी भी बदलें।']
      ],
      terms: [
        ['1. नियम और शर्तें', ['आयु: Vynzo खाता बनाने के लिए आपकी उम्र 18 वर्ष या उससे अधिक होनी चाहिए। 18 से कम उम्र के लोगों के खाते हटा दिए जाएँगे।', 'आपका खाता: अपना पासवर्ड सुरक्षित रखें। आपके खाते की गतिविधि के लिए आप जिम्मेदार हैं। आपकी Vynzo ID निजी है और साझा नहीं की जानी चाहिए।', 'आपकी सामग्री: जो आप पोस्ट करते हैं वह आपका है, और आप Vynzo को उसे सेवा चलाने के लिए संग्रहीत और प्रदर्शित करने की अनुमति देते हैं। केवल वही सामग्री पोस्ट करें जिसे साझा करने का आपको अधिकार है।', 'प्रवर्तन: इन नियमों को तोड़ने वाली सामग्री को Vynzo हटा सकता है, सुविधाएँ सीमित कर सकता है या खाते निलंबित कर सकता है।', 'बदलाव: ये शर्तें अपडेट हो सकती हैं। अपडेट के बाद Vynzo का उपयोग जारी रखने का मतलब है कि आप नया संस्करण स्वीकार करते हैं।']],
        ['2. सामुदायिक दिशानिर्देश', ['सम्मान रखें। उत्पीड़न, धमकी, नफ़रती भाषा या बदमाशी नहीं।', 'नग्नता या यौन सामग्री नहीं, नाबालिगों से जुड़ी यौन सामग्री नहीं, और सहमति के बिना निजी तस्वीरें साझा नहीं करनी हैं।', 'हिंसा, भयानक दुर्व्यवहार, या आत्म-हानि या अवैध गतिविधि को बढ़ावा देने वाली सामग्री नहीं।', 'स्पैम, धोखाधड़ी, नकली खाते या किसी की नकल नहीं।', 'कॉपीराइट और दूसरों की निजता का सम्मान करें। किसी की निजी जानकारी पोस्ट न करें।', 'ब्लॉग, स्टोरी, पोस्ट और लाइव स्ट्रीम का ईमानदारी से उपयोग करें। इन नियमों को तोड़ने वाली हर चीज़ की रिपोर्ट करें।']],
        ['3. नियम और मॉडरेशन', ['Vynzo का उपयोग करते समय आपको अपने निवास स्थान पर लागू कानूनों का पालन करना होगा।', 'फ़ोटो, वीडियो, स्टोरी और लाइव स्ट्रीम की अपने-आप जाँच होती है। नियम तोड़ने वाली सामग्री, पहले से अपलोड होने पर भी, हटा दी जाती है और आपको चेतावनी मिलेगी। नियम तोड़ने वाली लाइव स्ट्रीम समाप्त कर दी जाती है।', 'अवैध सामग्री, या जिसे हटाना Vynzo के लिए आवश्यक है, हटा दी जाएगी और अधिकारियों को सूचित की जा सकती है।', 'जहाँ अपील का विकल्प दिया गया हो, वहाँ आप मॉडरेशन निर्णय के खिलाफ अपील कर सकते हैं।']]
      ]
    },
    ar: {
      ui: { about: 'عن Vynzo', terms: 'الشروط وإرشادات المجتمع', back: 'رجوع', join: 'إنشاء حساب', login: 'تسجيل الدخول', lang: 'اللغة', version: 'الإصدار 2026-11-01' },
      intro: 'Vynzo شبكة اجتماعية لمشاركة لحظاتك مع الأشخاص المهمين لك. انشر وتحدث وابدأ بثًا مباشرًا واكتشف أشخاصًا جددًا، كل ذلك في مكان واحد.',
      about: [
        ['شارك لحظاتك', 'انشر الصور ومقاطع الفيديو وأضف الوصف والوسوم، وانشر قصصًا تختفي بعد 24 ساعة، واكتب مقالات في المدونة. سجّل فيديو مباشرة من الكاميرا أو عدّله في CapCut ثم ارفعه.'],
        ['تواصل مع الناس', 'ابحث عن أشخاص وتابعهم وكوّن صداقات. أرسل رسائل خاصة، واطّلع على عدد الرسائل غير المقروءة، وافتح النشاط لترى من أعجب بمنشوراتك وقصصك وفيديوهاتك ومدوناتك ومن تابعك.'],
        ['ابدأ بثًا مباشرًا', 'ابدأ بثًا مباشرًا واختر من يمكنه المشاهدة: الجميع أو الأصدقاء أو أصدقاء محددون فقط. ادعُ المشاهدين للظهور على الكاميرا كضيوف (حتى 12 شخصًا بمن فيهم أنت)، واستخدم مرآة الكاميرا، وتحدث مع جمهورك في الوقت الفعلي.'],
        ['آمن ومحترم', 'Vynzo للبالغين (18 عامًا فأكثر). تُفحص الصور والفيديوهات والقصص والبث المباشر تلقائيًا. يُحذف المحتوى الذي يتضمن عُريًا أو كراهية أو تنمرًا أو مواد مسيئة أخرى ويتلقى المستخدم تحذيرًا. ويمكنك أيضًا الإبلاغ عن المحتوى وحظر الأشخاص.'],
        ['لغتك وجهازك', 'يعمل Vynzo بـ 10 لغات، منها اللغات التي تُكتب من اليمين إلى اليسار، على الويب وكتطبيق أندرويد. غيّر اللغة في أي وقت.']
      ],
      terms: [
        ['1. الشروط والأحكام', ['العمر: يجب أن يكون عمرك 18 عامًا أو أكثر لإنشاء حساب في Vynzo. ستُحذف الحسابات التي تعود لمن هم دون 18 عامًا.', 'حسابك: حافظ على أمان كلمة المرور. أنت مسؤول عن النشاط على حسابك. معرّف Vynzo الخاص بك سري ويجب ألا تشاركه.', 'المحتوى الخاص بك: ما تنشره ملك لك، وتمنح Vynzo إذنًا بتخزينه وعرضه ليعمل الموقع. انشر فقط ما يحق لك مشاركته.', 'التطبيق: يجوز لـ Vynzo حذف المحتوى أو تقييد الميزات أو تعليق الحسابات التي تخالف هذه القواعد.', 'التغييرات: قد تُحدَّث هذه الشروط. استمرارك في استخدام Vynzo بعد التحديث يعني قبولك للنسخة الجديدة.']],
        ['2. إرشادات المجتمع', ['كن محترمًا. لا مضايقة ولا تهديد ولا خطاب كراهية ولا تنمر.', 'لا عُري ولا محتوى جنسي، ولا محتوى جنسي يتعلق بالقاصرين، ولا مشاركة صور خاصة دون موافقة.', 'لا عنف ولا إساءة صادمة ولا محتوى يشجع على إيذاء النفس أو الأنشطة غير القانونية.', 'لا بريد مزعج ولا احتيال ولا حسابات مزيفة ولا انتحال شخصية.', 'احترم حقوق النشر وخصوصية الآخرين. لا تنشر معلومات شخصية عن أي شخص.', 'استخدم المدونات والقصص والمنشورات والبث المباشر بأمانة. أبلغ عن أي شيء يخالف هذه القواعد.']],
        ['3. اللوائح والإشراف', ['يجب أن تلتزم بالقوانين المعمول بها في مكان إقامتك عند استخدام Vynzo.', 'تُفحص الصور والفيديوهات والقصص والبث المباشر تلقائيًا. يُحذف المحتوى المخالف حتى لو كان قد رُفع من قبل، وستتلقى تحذيرًا. ويُنهى البث المباشر المخالف.', 'يُحذف المحتوى غير القانوني أو الذي يلزم Vynzo بحذفه، وقد يُبلَّغ عنه للسلطات.', 'يمكنك الاعتراض على قرار الإشراف عندما يتوفر خيار الاعتراض.']]
      ]
    },
    fr: {
      ui: { about: 'À propos de Vynzo', terms: 'Conditions et règles de la communauté', back: 'Retour', join: 'Créer un compte', login: 'Se connecter', lang: 'Langue', version: 'Version 2026-11-01' },
      intro: 'Vynzo est un réseau social pour partager vos moments avec les personnes qui comptent pour vous. Publiez, discutez, passez en direct et découvrez de nouvelles personnes, au même endroit.',
      about: [
        ['Partagez vos moments', 'Publiez des images et des vidéos, ajoutez des légendes et des hashtags, partagez des stories qui disparaissent après 24 heures et écrivez des articles de blog. Filmez directement avec votre caméra ou montez votre vidéo avec CapCut puis importez-la.'],
        ['Connectez-vous', 'Trouvez des personnes, suivez-les et devenez amis. Envoyez des messages privés, voyez combien de messages non lus vous avez et ouvrez Activité pour voir qui a aimé vos publications, stories, vidéos et blogs, et qui vous a suivi.'],
        ['Passez en direct', 'Lancez un direct et choisissez qui peut le regarder : tout le monde, vos amis ou seulement les amis sélectionnés. Invitez des spectateurs à l\'écran comme invités (jusqu\'à 12 personnes, vous inclus), utilisez le miroir de la caméra et discutez en temps réel avec votre public.'],
        ['Sûr et respectueux', 'Vynzo est réservé aux adultes (18+). Les images, vidéos, stories et directs sont vérifiés automatiquement. Les contenus contenant de la nudité, de la haine, du harcèlement ou d\'autres éléments offensants sont supprimés et l\'utilisateur reçoit un avertissement. Vous pouvez aussi signaler des contenus et bloquer des personnes.'],
        ['Votre langue, votre appareil', 'Vynzo fonctionne en 10 langues, y compris de droite à gauche, sur le web et en application Android. Changez de langue à tout moment.']
      ],
      terms: [
        ['1. Conditions générales', ['Âge : vous devez avoir 18 ans ou plus pour créer un compte Vynzo. Les comptes de personnes de moins de 18 ans seront supprimés.', 'Votre compte : gardez votre mot de passe en sécurité. Vous êtes responsable de l\'activité de votre compte. Votre identifiant Vynzo est privé et ne doit pas être partagé.', 'Votre contenu : ce que vous publiez vous appartient et vous autorisez Vynzo à le stocker et l\'afficher pour que le service fonctionne. Ne publiez que ce que vous avez le droit de partager.', 'Application : Vynzo peut supprimer des contenus, restreindre des fonctions ou suspendre les comptes qui enfreignent ces règles.', 'Modifications : ces conditions peuvent être mises à jour. Continuer à utiliser Vynzo après une mise à jour signifie que vous acceptez la nouvelle version.']],
        ['2. Règles de la communauté', ['Soyez respectueux. Pas de harcèlement, de menaces, de discours haineux ni d\'intimidation.', 'Pas de nudité ni de contenu sexuel, pas de contenu sexuel impliquant des mineurs, et pas de partage d\'images privées sans consentement.', 'Pas de violence, d\'abus explicite ni de contenu incitant à l\'automutilation ou à des activités illégales.', 'Pas de spam, d\'arnaques, de faux comptes ni d\'usurpation d\'identité.', 'Respectez le droit d\'auteur et la vie privée des autres. Ne publiez pas les informations personnelles de quelqu\'un.', 'Utilisez honnêtement les blogs, stories, publications et directs. Signalez tout ce qui enfreint ces règles.']],
        ['3. Réglementation et modération', ['Vous devez respecter les lois en vigueur là où vous vivez en utilisant Vynzo.', 'Les images, vidéos, stories et directs sont vérifiés automatiquement. Un contenu qui enfreint les règles est supprimé, même s\'il a déjà été mis en ligne, et vous recevrez un avertissement. Un direct qui enfreint les règles est interrompu.', 'Les contenus illégaux, ou que Vynzo est tenu de supprimer, seront supprimés et pourront être signalés aux autorités.', 'Vous pouvez contester une décision de modération lorsqu\'une option de recours est proposée.']]
      ]
    },
    pt: {
      ui: { about: 'Sobre o Vynzo', terms: 'Termos e diretrizes da comunidade', back: 'Voltar', join: 'Criar conta', login: 'Entrar', lang: 'Idioma', version: 'Versão 2026-11-01' },
      intro: 'O Vynzo é uma rede social para compartilhar seus momentos com as pessoas que importam para você. Publique, converse, faça transmissões ao vivo e descubra novas pessoas, tudo em um só lugar.',
      about: [
        ['Compartilhe seus momentos', 'Publique imagens e vídeos, adicione legendas e hashtags, poste stories que somem após 24 horas e escreva artigos no blog. Grave um vídeo direto da câmera ou edite no CapCut e envie.'],
        ['Conecte-se com pessoas', 'Encontre pessoas, siga-as e torne-se amigo. Envie mensagens privadas, veja quantas mensagens não lidas você tem e abra Atividade para ver quem curtiu suas publicações, stories, vídeos e blogs e quem seguiu você.'],
        ['Transmita ao vivo', 'Inicie uma transmissão e escolha quem pode assistir: todos, amigos ou apenas amigos selecionados. Convide espectadores para a câmera como convidados (até 12 pessoas, incluindo você), use o espelho da câmera e converse com o público em tempo real.'],
        ['Seguro e respeitoso', 'O Vynzo é para adultos (18+). Imagens, vídeos, stories e transmissões são verificados automaticamente. Conteúdo com nudez, ódio, bullying ou outro material ofensivo é removido e o usuário recebe um aviso. Você também pode denunciar conteúdo e bloquear pessoas.'],
        ['Seu idioma, seu dispositivo', 'O Vynzo funciona em 10 idiomas, incluindo os escritos da direita para a esquerda, na web e como app Android. Troque o idioma quando quiser.']
      ],
      terms: [
        ['1. Termos e condições', ['Idade: você deve ter 18 anos ou mais para criar uma conta no Vynzo. Contas de menores de 18 anos serão removidas.', 'Sua conta: mantenha sua senha segura. Você é responsável pela atividade na sua conta. Seu ID do Vynzo é privado e não deve ser compartilhado.', 'Seu conteúdo: o que você publica é seu e você permite que o Vynzo o armazene e exiba para que o serviço funcione. Publique apenas conteúdo que você tem o direito de compartilhar.', 'Aplicação: o Vynzo pode remover conteúdo, restringir recursos ou suspender contas que violem estas regras.', 'Alterações: estes termos podem ser atualizados. Continuar usando o Vynzo após uma atualização significa que você aceita a nova versão.']],
        ['2. Diretrizes da comunidade', ['Seja respeitoso. Sem assédio, ameaças, discurso de ódio ou bullying.', 'Sem nudez ou conteúdo sexual, sem conteúdo sexual envolvendo menores e sem compartilhar imagens privadas sem consentimento.', 'Sem violência, abuso explícito ou conteúdo que incentive automutilação ou atividades ilegais.', 'Sem spam, golpes, contas falsas ou falsa identidade.', 'Respeite os direitos autorais e a privacidade dos outros. Não publique informações pessoais de ninguém.', 'Use blogs, stories, publicações e transmissões com honestidade. Denuncie qualquer coisa que viole estas regras.']],
        ['3. Regulamentos e moderação', ['Você deve seguir as leis aplicáveis onde mora ao usar o Vynzo.', 'Imagens, vídeos, stories e transmissões são verificados automaticamente. Conteúdo que viole as regras é excluído, mesmo que já tenha sido enviado, e você receberá um aviso. Uma transmissão que viole as regras é encerrada.', 'Conteúdo ilegal, ou que o Vynzo seja obrigado a remover, será removido e poderá ser comunicado às autoridades.', 'Você pode recorrer de uma decisão de moderação quando houver essa opção.']]
      ]
    },
    ru: {
      ui: { about: 'О Vynzo', terms: 'Условия и правила сообщества', back: 'Назад', join: 'Создать аккаунт', login: 'Войти', lang: 'Язык', version: 'Версия 2026-11-01' },
      intro: 'Vynzo — социальная сеть, где вы делитесь моментами с близкими людьми. Публикуйте, общайтесь, выходите в эфир и находите новых людей — всё в одном месте.',
      about: [
        ['Делитесь моментами', 'Публикуйте фото и видео, добавляйте подписи и хештеги, выкладывайте истории, исчезающие через 24 часа, и пишите статьи в блог. Снимайте видео прямо на камеру или монтируйте в CapCut и загружайте.'],
        ['Общайтесь с людьми', 'Находите людей, подписывайтесь и становитесь друзьями. Отправляйте личные сообщения, смотрите число непрочитанных и открывайте «Активность», чтобы увидеть, кто лайкнул ваши публикации, истории, видео и блоги и кто на вас подписался.'],
        ['Выходите в эфир', 'Запустите прямой эфир и выберите, кто может его смотреть: все, друзья или только выбранные друзья. Приглашайте зрителей в кадр как гостей (до 12 человек, включая вас), используйте зеркало камеры и общайтесь с аудиторией в реальном времени.'],
        ['Безопасно и уважительно', 'Vynzo предназначен для взрослых (18+). Изображения, видео, истории и эфиры проверяются автоматически. Контент с обнажённостью, ненавистью, травлей или другими оскорбительными материалами удаляется, а пользователь получает предупреждение. Вы также можете жаловаться на контент и блокировать людей.'],
        ['Ваш язык, ваше устройство', 'Vynzo работает на 10 языках, включая письмо справа налево, в вебе и как приложение для Android. Меняйте язык в любой момент.']
      ],
      terms: [
        ['1. Условия использования', ['Возраст: для создания аккаунта Vynzo вам должно быть 18 лет или больше. Аккаунты лиц младше 18 лет будут удалены.', 'Ваш аккаунт: храните пароль в безопасности. Вы отвечаете за действия в своём аккаунте. Ваш Vynzo ID конфиденциален и не должен передаваться.', 'Ваш контент: то, что вы публикуете, принадлежит вам; вы разрешаете Vynzo хранить и показывать это для работы сервиса. Публикуйте только то, что вправе распространять.', 'Применение: Vynzo может удалять контент, ограничивать функции или блокировать аккаунты, нарушающие эти правила.', 'Изменения: условия могут обновляться. Продолжая пользоваться Vynzo после обновления, вы принимаете новую версию.']],
        ['2. Правила сообщества', ['Будьте уважительны. Никаких преследований, угроз, языка ненависти и травли.', 'Никакой обнажённости и сексуального контента, никакого сексуального контента с участием несовершеннолетних и распространения личных изображений без согласия.', 'Никакого насилия, жестокости и контента, поощряющего самоповреждение или незаконные действия.', 'Никакого спама, мошенничества, фейковых аккаунтов и выдачи себя за других.', 'Уважайте авторские права и частную жизнь других. Не публикуйте чужие личные данные.', 'Честно используйте блоги, истории, публикации и эфиры. Сообщайте обо всём, что нарушает эти правила.']],
        ['3. Нормы и модерация', ['При использовании Vynzo вы должны соблюдать законы, действующие там, где вы живёте.', 'Изображения, видео, истории и эфиры проверяются автоматически. Контент, нарушающий правила, удаляется, даже если уже был загружен, и вы получите предупреждение. Эфир, нарушающий правила, прерывается.', 'Незаконный контент или контент, который Vynzo обязан удалить, будет удалён и может быть передан властям.', 'Вы можете обжаловать решение модерации, если предусмотрена такая возможность.']]
      ]
    },
    ur: {
      ui: { about: 'Vynzo کے بارے میں', terms: 'شرائط اور کمیونٹی رہنما اصول', back: 'واپس', join: 'اکاؤنٹ بنائیں', login: 'لاگ اِن', lang: 'زبان', version: 'ورژن 2026-11-01' },
      intro: 'Vynzo ایک سوشل نیٹ ورک ہے جہاں آپ اپنے لمحات ان لوگوں کے ساتھ بانٹتے ہیں جو آپ کے لیے اہم ہیں۔ پوسٹ کریں، چیٹ کریں، لائیو جائیں اور نئے لوگوں سے ملیں، سب ایک ہی جگہ۔',
      about: [
        ['اپنے لمحات شیئر کریں', 'تصاویر اور ویڈیوز پوسٹ کریں، کیپشن اور ہیش ٹیگ شامل کریں، 24 گھنٹے میں غائب ہونے والی اسٹوریز لگائیں اور بلاگ مضامین لکھیں۔ کیمرے سے براہِ راست ویڈیو ریکارڈ کریں یا CapCut میں ایڈٹ کر کے اپ لوڈ کریں۔'],
        ['لوگوں سے جڑیں', 'لوگوں کو تلاش کریں، فالو کریں اور دوست بنیں۔ نجی پیغامات بھیجیں، ان پڑھے پیغامات کی تعداد دیکھیں، اور سرگرمی کھول کر دیکھیں کہ کس نے آپ کی پوسٹس، اسٹوریز، ویڈیوز اور بلاگز کو لائک کیا اور کس نے آپ کو فالو کیا۔'],
        ['لائیو جائیں', 'لائیو اسٹریم شروع کریں اور چنیں کہ کون دیکھ سکتا ہے: سب، دوست یا صرف منتخب دوست۔ ناظرین کو مہمان کے طور پر کیمرے پر بلائیں (آپ سمیت 12 افراد تک)، کیمرہ مرر استعمال کریں اور اپنے ناظرین سے حقیقی وقت میں چیٹ کریں۔'],
        ['محفوظ اور باعزت', 'Vynzo بالغوں (18+) کے لیے ہے۔ تصاویر، ویڈیوز، اسٹوریز اور لائیو اسٹریمز کی خودکار جانچ ہوتی ہے۔ برہنگی، نفرت، ہراسانی یا دیگر قابلِ اعتراض مواد ہٹا دیا جاتا ہے اور صارف کو تنبیہ ملتی ہے۔ آپ مواد کی رپورٹ کر سکتے اور لوگوں کو بلاک بھی کر سکتے ہیں۔'],
        ['آپ کی زبان، آپ کا آلہ', 'Vynzo ویب پر اور اینڈرائیڈ ایپ کے طور پر 10 زبانوں میں چلتا ہے، دائیں سے بائیں لکھی جانے والی زبانوں سمیت۔ زبان کسی بھی وقت بدلیں۔']
      ],
      terms: [
        ['1. شرائط و ضوابط', ['عمر: Vynzo اکاؤنٹ بنانے کے لیے آپ کی عمر 18 سال یا اس سے زیادہ ہونی چاہیے۔ 18 سال سے کم عمر افراد کے اکاؤنٹس ہٹا دیے جائیں گے۔', 'آپ کا اکاؤنٹ: اپنا پاس ورڈ محفوظ رکھیں۔ اپنے اکاؤنٹ کی سرگرمی کے ذمہ دار آپ ہیں۔ آپ کی Vynzo ID نجی ہے اور اسے شیئر نہیں کرنا چاہیے۔', 'آپ کا مواد: جو آپ پوسٹ کرتے ہیں وہ آپ کا ہے، اور آپ Vynzo کو سروس چلانے کے لیے اسے محفوظ اور ظاہر کرنے کی اجازت دیتے ہیں۔ صرف وہی مواد پوسٹ کریں جسے شیئر کرنے کا آپ کو حق ہو۔', 'نفاذ: ان قواعد کی خلاف ورزی پر Vynzo مواد ہٹا سکتا ہے، خصوصیات محدود کر سکتا ہے یا اکاؤنٹس معطل کر سکتا ہے۔', 'تبدیلیاں: یہ شرائط اپ ڈیٹ ہو سکتی ہیں۔ اپ ڈیٹ کے بعد Vynzo کا استعمال جاری رکھنے کا مطلب ہے کہ آپ نیا ورژن قبول کرتے ہیں۔']],
        ['2. کمیونٹی رہنما اصول', ['باعزت رہیں۔ ہراسانی، دھمکیاں، نفرت انگیز گفتگو اور دھونس نہیں۔', 'برہنگی یا جنسی مواد نہیں، نابالغوں سے متعلق جنسی مواد نہیں، اور رضامندی کے بغیر نجی تصاویر شیئر نہیں کرنی۔', 'تشدد، ہولناک زیادتی، یا خود کو نقصان پہنچانے یا غیر قانونی سرگرمی کی ترغیب دینے والا مواد نہیں۔', 'اسپام، دھوکہ دہی، جعلی اکاؤنٹس یا کسی کی نقل نہیں۔', 'کاپی رائٹ اور دوسروں کی رازداری کا احترام کریں۔ کسی کی ذاتی معلومات پوسٹ نہ کریں۔', 'بلاگز، اسٹوریز، پوسٹس اور لائیو اسٹریمز ایمانداری سے استعمال کریں۔ ان قواعد کی خلاف ورزی کی رپورٹ کریں۔']],
        ['3. ضوابط اور نگرانی', ['Vynzo استعمال کرتے ہوئے آپ کو اپنی رہائش کی جگہ کے قوانین پر عمل کرنا ہوگا۔', 'تصاویر، ویڈیوز، اسٹوریز اور لائیو اسٹریمز کی خودکار جانچ ہوتی ہے۔ قواعد توڑنے والا مواد، پہلے سے اپ لوڈ ہونے کے باوجود، حذف کر دیا جاتا ہے اور آپ کو تنبیہ ملے گی۔ قواعد توڑنے والی لائیو اسٹریم ختم کر دی جاتی ہے۔', 'غیر قانونی مواد، یا جسے ہٹانا Vynzo پر لازم ہو، ہٹا دیا جائے گا اور حکام کو اطلاع دی جا سکتی ہے۔', 'جہاں اپیل کا اختیار دیا گیا ہو وہاں آپ نگرانی کے فیصلے کے خلاف اپیل کر سکتے ہیں۔']]
      ]
    }
  };

  var page = document.body.getAttribute('data-page');
  var root = document.getElementById('info-root');
  var lang = 'en';
  try {
    var saved = localStorage.getItem('vynzo_lang');
    if (T[saved]) lang = saved;
  } catch (e) { /* storage unavailable */ }

  function el(tag, text, cls) {
    var n = document.createElement(tag);
    if (text) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  }

  function render() {
    var d = T[lang];
    document.documentElement.setAttribute('lang', lang);
    document.documentElement.setAttribute('dir', RTL[lang] ? 'rtl' : 'ltr');
    document.title = 'Vynzo — ' + (page === 'terms' ? d.ui.terms : d.ui.about);
    root.textContent = '';

    var bar = el('div', '', 'info-bar');
    var back = el('a', '← ' + d.ui.back, 'info-back');
    back.href = page === 'terms' ? 'register.html' : '../index.html';
    var label = el('label', d.ui.lang + ': ', 'info-lang');
    var select = document.createElement('select');
    LANGS.forEach(function (l) {
      var o = document.createElement('option');
      o.value = l[0];
      o.textContent = l[1];
      if (l[0] === lang) o.selected = true;
      select.appendChild(o);
    });
    select.addEventListener('change', function () {
      lang = select.value;
      try { localStorage.setItem('vynzo_lang', lang); } catch (e) { /* ignore */ }
      render();
    });
    label.appendChild(select);
    bar.append(back, label);
    root.appendChild(bar);

    if (page === 'terms') {
      root.appendChild(el('h1', d.ui.terms));
      root.appendChild(el('p', d.ui.version, 'meta'));
      var ids = ['terms', 'guidelines', 'regulations'];
      d.terms.forEach(function (s, i) {
        var h = el('h2', s[0]);
        h.id = ids[i];
        root.appendChild(h);
        var ul = document.createElement('ul');
        s[1].forEach(function (item) { ul.appendChild(el('li', item)); });
        root.appendChild(ul);
      });
    } else {
      root.appendChild(el('h1', d.ui.about));
      root.appendChild(el('p', d.intro, 'lead'));
      var grid = el('div', '', 'info-grid');
      d.about.forEach(function (s, i) {
        var card = el('section', '', 'info-card');
        card.appendChild(el('span', String(i + 1), 'info-num'));
        card.appendChild(el('h2', s[0]));
        card.appendChild(el('p', s[1]));
        grid.appendChild(card);
      });
      root.appendChild(grid);
      var actions = el('div', '', 'info-actions');
      var join = el('a', d.ui.join, 'info-btn');
      join.href = 'register.html';
      var login = el('a', d.ui.login, 'info-btn info-btn-ghost');
      login.href = 'login.html';
      actions.append(join, login);
      root.appendChild(actions);
    }
    if (location.hash) {
      var target = document.getElementById(location.hash.slice(1));
      if (target) target.scrollIntoView();
    }
  }

  render();
})();
