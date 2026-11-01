const fs = require('fs/promises');
const path = require('path');

/*
 * Blog moderation engine.
 *
 * Layer 1 (always on): context-aware rule engine for English and Arabic. It scores each
 *   sentence, lowering the score for news/educational/negated context and raising it for
 *   instructional or inciting intent, so a bare keyword is never enough on its own.
 * Layer 2 (when OPENAI_API_KEY is set): the OpenAI omni-moderation model judges meaning for
 *   text and uploaded images. If that call fails, content is held for review (fail closed).
 *
 * Decisions: 'approve' | 'review' (admin must approve) | 'reject' (blocked, appealable).
 */

const REJECT_AT = 1.0;
const REVIEW_AT = 0.5;
const AI_REJECT_AT = 0.85;
const AI_REVIEW_AT = 0.4;

function aiEnabled() {
  return Boolean(process.env.OPENAI_API_KEY);
}

// 'auto' publishes content that passes; 'manual' always routes passing content to an admin.
function moderationMode() {
  const configured = (process.env.BLOG_MODERATION_MODE || '').toLowerCase();
  if (configured === 'auto' || configured === 'manual') return configured;
  return aiEnabled() ? 'auto' : 'manual';
}

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ');
}

const CONTEXT_SAFE = /(news|report(ed|s|ing)?|study|studies|research|histor(y|ical)|documentary|awareness|prevent(ion|ing)?|educat(ion|ional)|survivor|victim|law|legal|court|police|according to|warning|fight(ing)? against|combat|condemn|helpline|hotline|support group|خبر|تقرير|دراسه|بحث|تاريخ|وثائقي|توعيه|وقايه|منع|تعليم|ناجي|ضحيه|قانون|محكمه|ادانه|محاربه|مكافحه|تحذير|بحسب|وفقا|خط مساعده)/;
const INTENT_BOOST = /(how to|step[- ]by[- ]step|tutorial|guide to|instructions?|you (must|should|need to)|let'?s|join us|easy way|best way|كيف|خطوات|طريقه|شرح|يجب عليك|انضم|انضموا)/;
const NEGATION = /(not|never|no|don'?t|do not|stop|against|without|لا|ليس|ضد|بدون|كفى)\s+\S{0,12}$/;

const RELIGION_TERMS = '(god|allah|prophet|muhammad|mohammed|jesus|christ|quran|koran|bible|torah|islam|muslims?|christianity|judaism|church|mosque|synagogue|الله|النبي|الرسول|محمد|القران|الاسلام|المسيح|الانجيل|التوراه|الكنيسه|المسجد|المسلمين|المسيحيين|اليهود)';
const MINOR_TERMS = '(child|children|kid|kids|minor|underage|toddler|infant|schoolgirl|schoolboy|little (girl|boy)|طفل|اطفال|طفله|قاصر|قاصرات|صغير|صغيره)';
const SEX_EXPLICIT = '(porn|porno|pornography|nude|naked|nudes|sex video|sexual (act|content|video|photo|images?)|sex with|rape video|اباحي|اباحيه|عاري|عاريه|سكس|جنسي مع|فيديو جنسي|صور جنسيه)';
const GROUPS = '(muslims|christians|jews|blacks|whites|arabs|asians|women|gays|lesbians|immigrants|refugees|foreigners|المسلمين|المسيحيين|اليهود|السود|العرب|النساء|المثليين|اللاجئين|الاجانب)';

// weight = score for one matching sentence. flags: absolute = ignore safe-context dampening mostly.
const RULES = [
  { cat: 'sexual', weight: 0.6, re: /\b(porn|porno|pornography|xxx|nsfw|blowjob|handjob|hardcore sex|sex tape|onlyfans leak|erotic story|nudes?)\b|اباحي|اباحيه|سكس|دعاره|شرموط|نيك/ },
  { cat: 'sexual', weight: 1.1, re: /\b(explicit sex(ual)? (scene|story|video|content)|how to have sex with|sell(ing)? nudes)\b|مقاطع جنسيه صريحه/ },
  { cat: 'sexual_minors', weight: 1.5, absolute: true, re: new RegExp(`${MINOR_TERMS}.{0,60}${SEX_EXPLICIT}|${SEX_EXPLICIT}.{0,60}${MINOR_TERMS}`) },
  { cat: 'sexual_minors', weight: 1.3, absolute: true, re: new RegExp(`(don'?t tell your (parents|mom|dad)|our (little )?secret|لا تخبر (اهلك|امك|ابوك)|سر بيننا).{0,80}${MINOR_TERMS}|${MINOR_TERMS}.{0,80}(don'?t tell your (parents|mom|dad)|our (little )?secret|سر بيننا)`) },
  { cat: 'sexual_minors', weight: 1.2, absolute: true, re: /\b(cp|c\.p\.) (links?|videos?|trade)|child (porn|sex) (links?|videos?)|\bloli(con)?\b.{0,20}(nsfw|porn)/ },
  { cat: 'hate', weight: 1.2, re: new RegExp(`(all|those|these|كل|هؤلاء)\\s+${GROUPS}\\s+(are|is|should|must|يجب|هم|هن)?\\s*(\\S+\\s+){0,2}(animals?|vermin|trash|filth(y)?|scum|subhuman|parasites|cockroaches|die|be killed|be expelled|كلاب|حيوانات|حشرات|قذرون|قذرين|يجب قتلهم|يجب طردهم|اقتلوا)`) },
  { cat: 'hate', weight: 1.1, re: new RegExp(`(kill|exterminate|eradicate|wipe out|اقتلوا|ابيدوا|ابادة)\\s+(all\\s+|every\\s+|كل\\s+)?${GROUPS}`) },
  { cat: 'hate', weight: 0.6, re: /\b(master race|racial purity|go back to your country|ethnic cleansing)\b|نقاء العرق|عودوا الى بلدكم/ },
  { cat: 'religion', weight: 1.1, re: new RegExp(`(fuck|shit on|piss on|curse|damn|burn|trash|garbage|spit on|insult|لعنه|سب|شتم|اهانه|قذاره|ازبل|احرقوا)\\s+(\\S+\\s+){0,3}${RELIGION_TERMS}|${RELIGION_TERMS}\\s+(is|are|هو|هي|هم)\\s+(a\\s+)?(fake|joke|garbage|trash|filth|lie|stupid|evil|دجل|كذبه|قذر|حقير|تافه)`) },
  { cat: 'religion', weight: 0.7, re: new RegExp(`(mock|mocking|ridicule|laugh at|make fun of|استهزاء|سخريه|السخريه|يسخر|تهكم)\\s+(\\S+\\s+){0,4}${RELIGION_TERMS}|${RELIGION_TERMS}\\s+(\\S+\\s+){0,4}(mock|joke|ridicule|استهزاء|نكته|سخريه)`) },
  { cat: 'self_harm', weight: 1.3, intent: true, re: /\b(kill yourself|go (and )?die|hang yourself|you should (just )?(die|kill yourself)|better off dead)\b|اقتل نفسك|انتحر\b|اشنق نفسك|الافضل ان تموت/ },
  { cat: 'self_harm', weight: 1.1, intent: true, re: /\b(how to (commit suicide|kill myself|end my life|cut myself|self[- ]harm)|painless (way|method)s? to (die|kill)|best way to (die|kill myself)|suicide (methods?|guide|plan))\b|كيف انتحر|طريقه الانتحار|طرق الانتحار|اسهل طريقه للموت|كيف اوذي نفسي/ },
  { cat: 'self_harm', weight: 0.6, re: /\b(suicide|self[- ]harm|cutting myself|end it all)\b|الانتحار|ايذاء النفس|ايذاء الذات/ },
  { cat: 'violence_extremism', weight: 1.3, intent: true, re: /\bhow to (make|build|assemble) (a |an )?(bomb|explosive|ied|pipe bomb|nerve agent|molotov)|(بناء|صنع|تجهيز) (قنبله|متفجرات|عبوه ناسفه)|كيف (اصنع|اعمل) (قنبله|متفجرات)/ },
  { cat: 'violence_extremism', weight: 1.2, re: /\b(long live|glory to|join|support|pledge allegiance to|bayah to)\s+(isis|isil|daesh|al[- ]qaeda|al[- ]shabaab|boko haram|taliban)|تحيا داعش|بايع(نا)? داعش|الانضمام الى (داعش|القاعده)|انضم الى (داعش|القاعده)/ },
  { cat: 'violence_extremism', weight: 0.9, intent: true, re: /\b(death to|kill all|attack (the )?(infidels|crusaders|kuffar)|(carry out|plan) (a |an )?(attack|massacre|shooting|bombing))\b|الموت ل|اقتلوا (الكفار|الصليبيين)|نفذوا (هجوم|عمليه انتحاريه)/ },
  { cat: 'graphic_violence', weight: 0.7, re: /\b(gore|beheading video|decapitat(ed|ion) (video|footage)|dismember(ed|ment)|torture video|snuff)\b|مقطع ذبح|فيديو ذبح|تقطيع (الجثه|الجثث)|مشاهد دمويه/ },
  { cat: 'illegal', weight: 1.1, intent: true, re: /\bhow to (hack into|steal|launder money|make meth|cook meth|synthesi[sz]e (meth|fentanyl)|buy (cocaine|heroin|meth)|forge|counterfeit|evade (the )?police|get away with (murder|theft)|make (a )?(fake id|ghost gun))\b|كيف (اخترق حساب|اسرق|اغسل الاموال|اصنع مخدرات|ازور|اتهرب من الشرطه)/ },
  { cat: 'illegal', weight: 0.9, re: /\b(stolen credit cards?|cvv dumps?|carding (tutorial|forum)|buy drugs online|dark ?web (market|vendor)s? for (drugs|weapons)|hire a hitman)\b|بطاقات ائتمان مسروقه|شراء مخدرات|استئجار قاتل/ },
  { cat: 'scam', weight: 0.7, re: /\b(guaranteed (profit|returns?|income|payout)|double your (money|bitcoin|crypto|investment)|risk[- ]free (investment|profit)|send (btc|usdt|crypto|bitcoin|money) to|wire transfer fee|congratulations,? you (have )?won|claim your prize|make \$?\d+ ?(k|,000)? (a|per) (day|week) from home|get rich quick)\b|ربح مضمون|ارباح مضمونه|ضاعف (اموالك|رصيدك)|ارسل (مبلغ|usdt|بيتكوين)|مبروك لقد ربحت|اربح من المنزل|اغتني بسرعه/ },
  { cat: 'misinformation', weight: 0.7, re: /\b(vaccines? cause autism|drink bleach|miracle cure|cure[sd]? (cancer|diabetes|aids|covid)( with| using| by)|5g (causes|spreads) (covid|coronavirus)|stop taking your (insulin|medication)|don'?t vaccinate)\b|التطعيم يسبب التوحد|اشرب (المبيض|الكلور)|علاج (السرطان|السكري) (ب|عن طريق)|لا تاخذ (الانسولين|الدواء)/ },
  { cat: 'copyright', weight: 0.7, re: /\b(full movie (free )?download|free download (cracked|crack|keygen)|cracked (software|version)|keygen|torrent (link|download)|pirated (copy|movie|software|course)|leaked (movie|album|course|ebook)|watch .{0,30} free online full)\b|تحميل (فيلم )?كامل مجانا|نسخه مكركه|تحميل كراك|فيلم مسرب|دوره مسربه|تحميل تورنت/ },
  { cat: 'harassment', weight: 0.9, re: /\b(i (will|'ll|am going to) (find|kill|hurt|rape|stalk) you|i know where you live|you (stupid|worthless) (bitch|idiot|piece of (shit|trash)))\b|سوف اجدك واقتلك|اعرف اين تسكن|يا (حقير|ابن الكلب|ابن الحرام)/ }
];

function splitSentences(text) {
  return text.split(/(?<=[.!?\u061F\u061B\n])\s+/).map(s => s.trim()).filter(Boolean);
}

function ruleScan(rawText) {
  const text = normalize(rawText);
  const scores = {};
  const evidence = [];
  const sentences = splitSentences(text).slice(0, 4000);

  for (const sentence of sentences) {
    const safeContext = CONTEXT_SAFE.test(sentence);
    const boosted = INTENT_BOOST.test(sentence);
    for (const rule of RULES) {
      const match = sentence.match(rule.re);
      if (!match) continue;
      let score = rule.weight;
      const before = sentence.slice(Math.max(0, match.index - 18), match.index);
      if (NEGATION.test(before)) score *= 0.45;
      if (safeContext) score *= rule.absolute ? 0.6 : 0.45;
      if (boosted && rule.intent) score *= 1.4;
      scores[rule.cat] = Math.min(2, (scores[rule.cat] || 0) + score);
      evidence.push({ category: rule.cat, score: Number(score.toFixed(2)) });
    }
  }
  return { scores, evidence: evidence.length };
}

// Spam heuristics: not a policy violation, but low-quality or abusive posting patterns.
function spamScan(rawText) {
  const text = String(rawText || '');
  const links = (text.match(/https?:\/\/|www\./gi) || []).length;
  const repeated = /(.)\1{14,}/.test(text);
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const unique = new Set(words).size;
  const lowVariety = words.length > 60 && unique / words.length < 0.2;
  const reasons = [];
  if (links > 8) reasons.push('too_many_links');
  if (repeated) reasons.push('repeated_characters');
  if (lowVariety) reasons.push('repetitive_text');
  return reasons;
}

const AI_CATEGORY_MAP = {
  sexual: 'sexual',
  'sexual/minors': 'sexual_minors',
  hate: 'hate',
  'hate/threatening': 'hate',
  harassment: 'harassment',
  'harassment/threatening': 'harassment',
  'self-harm': 'self_harm',
  'self-harm/intent': 'self_harm',
  'self-harm/instructions': 'self_harm',
  violence: 'graphic_violence',
  'violence/graphic': 'graphic_violence',
  illicit: 'illegal',
  'illicit/violent': 'violence_extremism'
};

async function aiModerate(input) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch('https://api.openai.com/v1/moderations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({ model: process.env.BLOG_MODERATION_MODEL || 'omni-moderation-latest', input }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`moderation API ${response.status}`);
    const data = await response.json();
    const scores = {};
    for (const result of data.results || []) {
      for (const [name, value] of Object.entries(result.category_scores || {})) {
        const cat = AI_CATEGORY_MAP[name];
        if (cat) scores[cat] = Math.max(scores[cat] || 0, value);
      }
    }
    return scores;
  } finally {
    clearTimeout(timer);
  }
}

function chunkText(text, size = 8000) {
  const chunks = [];
  for (let i = 0; i < text.length && chunks.length < 6; i += size) chunks.push(text.slice(i, i + size));
  return chunks.length ? chunks : [''];
}

async function imageToDataUrl(publicPath) {
  const file = path.join(__dirname, '../../uploads', path.basename(publicPath));
  const stat = await fs.stat(file);
  if (stat.size > 4 * 1024 * 1024) throw new Error('image too large to scan');
  const buffer = await fs.readFile(file);
  const ext = path.extname(file).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

function decide(scores) {
  const categories = Object.entries(scores)
    .map(([name, score]) => ({ name, score: Number(score.toFixed(2)) }))
    .sort((a, b) => b.score - a.score);
  const top = categories[0];
  return { categories, top };
}

/**
 * @param {{text: string, title?: string, images?: string[], hasEmbeds?: boolean, strict?: boolean}} input
 * @returns {Promise<{decision: string, categories: object[], reasons: string[], engine: string[]}>}
 */
async function moderateContent({ text, title = '', images = [], hasEmbeds = false }) {
  const full = `${title}\n${text}`;
  const engine = ['rules'];
  const reasons = [];
  const rules = ruleScan(full);
  const scores = { ...rules.scores };

  const spam = spamScan(full);
  if (spam.length) reasons.push(...spam);

  let aiFailed = false;
  let imagesChecked = images.length === 0;
  if (aiEnabled()) {
    try {
      for (const chunk of chunkText(full)) {
        if (!chunk.trim()) continue;
        const ai = await aiModerate(chunk);
        for (const [cat, value] of Object.entries(ai)) {
          // AI scores are probabilities; map them onto the same scale as the rules.
          const mapped = value >= AI_REJECT_AT ? 1.0 + value : value >= AI_REVIEW_AT ? 0.5 + value / 4 : 0;
          if (mapped) scores[cat] = Math.max(scores[cat] || 0, mapped);
        }
      }
      for (const image of images.slice(0, 8)) {
        const ai = await aiModerate([{ type: 'image_url', image_url: { url: await imageToDataUrl(image) } }]);
        for (const [cat, value] of Object.entries(ai)) {
          const mapped = value >= AI_REJECT_AT ? 1.0 + value : value >= AI_REVIEW_AT ? 0.5 + value / 4 : 0;
          if (mapped) scores[`image_${cat}`] = Math.max(scores[`image_${cat}`] || 0, mapped);
        }
      }
      imagesChecked = true;
      engine.push('ai');
    } catch (err) {
      console.error('Blog AI moderation failed:', err.message);
      aiFailed = true;
    }
  }

  const { categories, top } = decide(scores);
  let decision = 'approve';
  if (top && top.score >= REJECT_AT) decision = 'reject';
  else if (top && top.score >= REVIEW_AT) decision = 'review';

  if (decision === 'approve') {
    if (aiFailed) { decision = 'review'; reasons.push('automated_check_unavailable'); }
    else if (!imagesChecked || (images.length && !engine.includes('ai'))) { decision = 'review'; reasons.push('images_need_manual_check'); }
    else if (hasEmbeds) { decision = 'review'; reasons.push('embedded_media_needs_manual_check'); }
    else if (spam.length) { decision = 'review'; }
    else if (moderationMode() === 'manual') { decision = 'review'; reasons.push('manual_approval_required'); }
  }
  return { decision, categories, reasons, engine };
}

// Comments are short and live immediately unless flagged, so only clear passes go public.
async function moderateComment(text) {
  const result = await moderateContent({ text });
  if (result.decision === 'review'
    && result.categories.length === 0
    && result.reasons.every(r => r === 'manual_approval_required')) {
    return { ...result, decision: 'approve' };
  }
  return result;
}

module.exports = { moderateContent, moderateComment, moderationMode, aiEnabled, normalize, ruleScan };
