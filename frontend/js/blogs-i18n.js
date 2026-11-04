const DICT = {
  en: {
    title: 'Vynzo Blogs', subtitle: 'Long-form stories from the community',
    write: 'Write', feed: 'Explore', mine: 'My articles', bookmarks: 'Saved', admin: 'Moderation',
    search: 'Search articles, authors or #tags', latest: 'Latest', trending: 'Trending', all: 'All',
    trendingTags: 'Trending tags', empty: 'Nothing here yet.', loadMore: 'Load more', loading: 'Loading...',
    back: 'Back', readMin: 'min read', views: 'views', like: 'Like', share: 'Share', save: 'Save', saved: 'Saved',
    report: 'Report', comments: 'Comments', addComment: 'Write a comment...', send: 'Send', delete: 'Delete',
    follow: 'Follow', following: 'Following', followers: 'followers', articles: 'articles', totalViews: 'views',
    totalLikes: 'likes', copied: 'Link copied',     updateArticle: 'Update article', liveEditNote: 'This article is live. Updating re-checks it and republishes it within a minute; saving as a draft takes it offline.', edit: 'Edit', unpublish: 'Unpublish',
    newArticle: 'New article', editArticle: 'Edit article', titleLbl: 'Title', titlePh: 'A clear, honest title',
    category: 'Category', tags: 'Tags (comma separated)', cover: 'Cover image', setCover: 'Choose cover',
    removeCover: 'Remove cover', saveDraft: 'Save draft', submit: 'Submit for publication',
    uploading: 'Uploading…', uploadVideo: 'Upload video', videoUploaded: '✅ Video uploaded successfully', imageUploaded: '✅ Image uploaded successfully', coverUploaded: '✅ Cover image uploaded successfully', videoAdded: '✅ Video added successfully',
    draftSaved: 'Draft saved', body: 'Article', insertImage: 'Image', insertLink: 'Link', insertVideo: 'Video',
    linkPrompt: 'Link address (https://...)', videoPrompt: 'YouTube or Vimeo link',
    policyNote: 'Every article is checked automatically before it is visible. Content that breaks the Vynzo policy is rejected and counts as a strike.',
    status_draft: 'Draft', status_pending: 'Checking', status_in_review: 'Waiting for admin review',
    status_published: 'Published', status_rejected: 'Rejected', status_removed: 'Removed',
    strikes: 'Policy strikes', bannedUntil: 'Blogging paused until',
    appeal: 'Appeal', appealPh: 'Explain why this decision should be reviewed (min 10 characters)',
    appealSent: 'Appeal sent', appealStatus: 'Appeal', reason: 'Reason',
    reportTitle: 'Report this content', reportDetails: 'Details (optional)', reportSent: 'Report sent',
    cancel: 'Cancel', confirmDelete: 'Delete this permanently?', held: 'Waiting for moderator review',
    r_sexual: 'Sexual content', r_child_safety: 'Child safety', r_religious_hate: 'Religious hatred or insult',
    r_self_harm: 'Self-harm', r_hate_harassment: 'Hate or harassment', r_extremism: 'Terrorism / extremism',
    r_illegal: 'Illegal activity', r_violence: 'Graphic violence', r_misinformation: 'Dangerous misinformation',
    r_copyright: 'Copyright', r_spam_scam: 'Spam or scam', r_other: 'Other',
    c_general: 'General', c_technology: 'Technology', c_lifestyle: 'Lifestyle', c_travel: 'Travel', c_food: 'Food',
    c_health: 'Health', c_education: 'Education', c_business: 'Business', c_entertainment: 'Entertainment',
    c_sports: 'Sports', c_art: 'Art', c_opinion: 'Opinion', c_news: 'News', c_family: 'Family',
    langBtn: 'العربية', home: 'Home', find: 'Find people', messages: 'Messages', live: 'Live', settings: 'Settings',
    error: 'Something went wrong'
  },
  ar: {
    title: 'مدونات فينزو', subtitle: 'قصص ومقالات من المجتمع',
    write: 'اكتب', feed: 'استكشف', mine: 'مقالاتي', bookmarks: 'المحفوظات', admin: 'الإشراف',
    search: 'ابحث عن مقالات أو كتّاب أو #وسوم', latest: 'الأحدث', trending: 'الأكثر رواجاً', all: 'الكل',
    trendingTags: 'الوسوم الرائجة', empty: 'لا يوجد شيء بعد.', loadMore: 'عرض المزيد', loading: 'جارٍ التحميل...',
    back: 'رجوع', readMin: 'دقيقة قراءة', views: 'مشاهدة', like: 'إعجاب', share: 'مشاركة', save: 'حفظ', saved: 'محفوظ',
    report: 'إبلاغ', comments: 'التعليقات', addComment: 'اكتب تعليقاً...', send: 'إرسال', delete: 'حذف',
    follow: 'متابعة', following: 'تتابعه', followers: 'متابع', articles: 'مقال', totalViews: 'مشاهدة',
    totalLikes: 'إعجاب', copied: 'تم نسخ الرابط',     updateArticle: 'تحديث المقال', liveEditNote: 'هذا المقال منشور. التحديث يعيد فحصه ونشره خلال دقيقة، وحفظه كمسودة يخفيه عن النشر.', edit: 'تعديل', unpublish: 'إلغاء النشر',
    newArticle: 'مقال جديد', editArticle: 'تعديل المقال', titleLbl: 'العنوان', titlePh: 'عنوان واضح وصادق',
    category: 'التصنيف', tags: 'الوسوم (مفصولة بفواصل)', cover: 'صورة الغلاف', setCover: 'اختر غلافاً',
    removeCover: 'إزالة الغلاف', saveDraft: 'حفظ كمسودة', submit: 'إرسال للنشر',
    uploading: 'جارٍ الرفع…', uploadVideo: 'رفع فيديو', videoUploaded: '✅ تم رفع الفيديو بنجاح', imageUploaded: '✅ تم رفع الصورة بنجاح', coverUploaded: '✅ تم رفع صورة الغلاف بنجاح', videoAdded: '✅ تمت إضافة الفيديو بنجاح',
    draftSaved: 'تم حفظ المسودة', body: 'المقال', insertImage: 'صورة', insertLink: 'رابط', insertVideo: 'فيديو',
    linkPrompt: 'عنوان الرابط (https://...)', videoPrompt: 'رابط يوتيوب أو فيميو',
    policyNote: 'يُفحص كل مقال تلقائياً قبل ظهوره. المحتوى المخالف لسياسة فينزو يُرفض ويُحتسب كإنذار.',
    status_draft: 'مسودة', status_pending: 'قيد الفحص', status_in_review: 'بانتظار مراجعة المشرف',
    status_published: 'منشور', status_rejected: 'مرفوض', status_removed: 'محذوف',
    strikes: 'إنذارات السياسة', bannedUntil: 'الكتابة موقوفة حتى',
    appeal: 'اعتراض', appealPh: 'اشرح سبب طلب إعادة النظر (10 أحرف على الأقل)',
    appealSent: 'تم إرسال الاعتراض', appealStatus: 'الاعتراض', reason: 'السبب',
    reportTitle: 'الإبلاغ عن هذا المحتوى', reportDetails: 'تفاصيل (اختياري)', reportSent: 'تم إرسال البلاغ',
    cancel: 'إلغاء', confirmDelete: 'حذف نهائي؟', held: 'بانتظار مراجعة المشرف',
    r_sexual: 'محتوى جنسي', r_child_safety: 'سلامة الأطفال', r_religious_hate: 'كراهية أو إساءة دينية',
    r_self_harm: 'إيذاء النفس', r_hate_harassment: 'كراهية أو تحرش', r_extremism: 'إرهاب / تطرف',
    r_illegal: 'نشاط غير قانوني', r_violence: 'عنف مصوّر', r_misinformation: 'معلومات مضللة خطيرة',
    r_copyright: 'حقوق النشر', r_spam_scam: 'رسائل مزعجة أو احتيال', r_other: 'أخرى',
    c_general: 'عام', c_technology: 'تقنية', c_lifestyle: 'نمط حياة', c_travel: 'سفر', c_food: 'طعام',
    c_health: 'صحة', c_education: 'تعليم', c_business: 'أعمال', c_entertainment: 'ترفيه',
    c_sports: 'رياضة', c_art: 'فن', c_opinion: 'رأي', c_news: 'أخبار', c_family: 'أسرة',
    langBtn: 'English', home: 'الرئيسية', find: 'البحث عن أشخاص', messages: 'الرسائل', live: 'مباشر', settings: 'الإعدادات',
    error: 'حدث خطأ ما'
  }
};

let lang = localStorage.getItem('vynzo_lang') === 'ar' ? 'ar' : 'en';

export function setLang(l) {
  lang = l === 'ar' ? 'ar' : 'en';
  applyLang();
}

export const getLang = () => lang;
export const t = key => DICT[lang][key] ?? DICT.en[key] ?? key;

export function applyLang() {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
}

export function toggleLang() {
  const next = lang === 'ar' ? 'en' : 'ar';
  if (window.VynzoI18n) window.VynzoI18n.set(next);
  setLang(next);
  return lang;
}
