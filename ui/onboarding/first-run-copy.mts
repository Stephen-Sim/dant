import type { LanguageCode } from '../i18n/languages.mts';

export interface FirstRunCopy {
  title: string;
  intro: string;
  choose: string;
  review: string;
  signin: string;
  create: string;
  existing: string;
  manual: string;
  checking: string;
  found: string;
  unsupported: string;
  permissions: string;
  loadFailed: string;
  backupTitle: string;
  backupIntro: string;
  importBackup: string;
  noBackup: string;
  back: string;
}

export const firstRunMessages: Readonly<Record<LanguageCode, FirstRunCopy>> = {
  en: {
    title: 'First, give dant a computer',
    intro:
      'dant works in its own Ubuntu virtual machine. Set up its work computer before you start chatting.',
    choose: 'Choose Hyper-V or VMware',
    review: 'Review resources and permissions',
    signin: 'Create the computer, then sign in to ChatGPT',
    create: 'Create a work computer',
    existing: 'Use or import an existing computer',
    manual: 'Connect through SSH',
    checking: 'Checking existing computers and VM providers…',
    found: 'An existing work computer was found. Use or import it to keep your data.',
    unsupported:
      'No supported VM provider was found. Enable Hyper-V or install VMware, or connect through SSH.',
    permissions:
      'Creation starts only after you confirm. Windows may ask for administrator permission.',
    loadFailed:
      'Existing computers could not be checked. You can review them in work computer settings.',
    backupTitle: 'Do you have a dant backup?',
    backupIntro: 'Bring your dant data with you, or set up a new work computer.',
    importBackup: 'Import a dant backup',
    noBackup: 'No backup — start fresh',
    back: 'Back',
  },
  zh: {
    title: '先为 dant 准备一台电脑',
    intro: 'dant 在自己的 Ubuntu 虚拟机中工作。先创建工作电脑，再开始聊天。',
    choose: '选择 Hyper-V 或 VMware',
    review: '确认资源和权限',
    signin: '创建电脑，然后登录 ChatGPT',
    create: '创建工作电脑',
    existing: '使用或导入已有电脑',
    manual: '通过 SSH 连接',
    checking: '正在检查已有电脑和虚拟机环境…',
    found: '发现已有工作电脑。使用或导入它，即可保留原来的数据。',
    unsupported: '未检测到支持的虚拟机环境。请启用 Hyper-V、安装 VMware，或通过 SSH 连接已有电脑。',
    permissions: '确认后才会开始创建，Windows 可能会请求管理员权限。',
    loadFailed: '暂时无法检查已有电脑，可以在工作电脑设置中查看。',
    backupTitle: '你有 dant 备份吗？',
    backupIntro: '可以带着原来的 dant 数据迁移，也可以从零创建工作电脑。',
    importBackup: '导入 dant 备份',
    noBackup: '没有备份，从零开始',
    back: '返回',
  },
  'zh-TW': {
    title: '先為 dant 準備一台電腦',
    intro: 'dant 在自己的 Ubuntu 虛擬機中工作。先建立工作電腦，再開始聊天。',
    choose: '選擇 Hyper-V 或 VMware',
    review: '確認資源與權限',
    signin: '建立電腦，然後登入 ChatGPT',
    create: '建立工作電腦',
    existing: '使用或匯入現有電腦',
    manual: '透過 SSH 連線',
    checking: '正在檢查現有電腦與虛擬機環境…',
    found: '找到現有工作電腦。使用或匯入它，即可保留原有資料。',
    unsupported: '未偵測到支援的虛擬機環境。請啟用 Hyper-V、安裝 VMware，或透過 SSH 連線。',
    permissions: '確認後才會開始建立，Windows 可能會要求管理員權限。',
    loadFailed: '暫時無法檢查現有電腦，可以在工作電腦設定中查看。',
    backupTitle: '你有 dant 備份嗎？',
    backupIntro: '可以帶著原有的 dant 資料遷移，也可以從零建立工作電腦。',
    importBackup: '匯入 dant 備份',
    noBackup: '沒有備份，從零開始',
    back: '返回',
  },
  ja: {
    title: 'まず dant のパソコンを準備しましょう',
    intro:
      'dant は専用の Ubuntu 仮想マシンで作業します。チャットを始める前に作業用パソコンを設定してください。',
    choose: 'Hyper-V または VMware を選ぶ',
    review: 'リソースと権限を確認する',
    signin: 'パソコンを作成して ChatGPT にログインする',
    create: '作業用パソコンを作成',
    existing: '既存のパソコンを使用・インポート',
    manual: 'SSH で接続',
    checking: '既存のパソコンと仮想環境を確認しています…',
    found: '既存の作業用パソコンが見つかりました。使用またはインポートするとデータを引き継げます。',
    unsupported:
      '対応する仮想環境が見つかりません。Hyper-V を有効にするか VMware をインストールするか、SSH で接続してください。',
    permissions: '確認後に作成が始まります。Windows が管理者権限を求める場合があります。',
    loadFailed: '既存のパソコンを確認できませんでした。作業用パソコンの設定で確認できます。',
    backupTitle: 'dant のバックアップはありますか？',
    backupIntro: '以前の dant データを引き継ぐか、新しい作業用パソコンを設定できます。',
    importBackup: 'dant バックアップをインポート',
    noBackup: 'バックアップなしで始める',
    back: '戻る',
  },
  ko: {
    title: '먼저 dant의 컴퓨터를 준비하세요',
    intro: 'dant는 전용 Ubuntu 가상 머신에서 작업합니다. 채팅 전에 작업 컴퓨터를 설정하세요.',
    choose: 'Hyper-V 또는 VMware 선택',
    review: '리소스 및 권한 확인',
    signin: '컴퓨터를 만들고 ChatGPT에 로그인',
    create: '작업 컴퓨터 만들기',
    existing: '기존 컴퓨터 사용 또는 가져오기',
    manual: 'SSH로 연결',
    checking: '기존 컴퓨터와 가상 머신 환경을 확인하는 중…',
    found: '기존 작업 컴퓨터를 찾았습니다. 사용하거나 가져오면 데이터를 유지할 수 있습니다.',
    unsupported:
      '지원되는 가상 머신 환경을 찾지 못했습니다. Hyper-V를 켜거나 VMware를 설치하거나 SSH로 연결하세요.',
    permissions: '확인한 후에만 생성이 시작됩니다. Windows에서 관리자 권한을 요청할 수 있습니다.',
    loadFailed: '기존 컴퓨터를 확인하지 못했습니다. 작업 컴퓨터 설정에서 확인할 수 있습니다.',
    backupTitle: 'dant 백업이 있나요?',
    backupIntro: '기존 dant 데이터를 가져오거나 새 작업 컴퓨터를 설정할 수 있습니다.',
    importBackup: 'dant 백업 가져오기',
    noBackup: '백업 없이 새로 시작',
    back: '뒤로',
  },
  es: {
    title: 'Primero, prepara un ordenador para dant',
    intro:
      'dant trabaja en su propia máquina virtual Ubuntu. Configura su ordenador de trabajo antes de empezar a chatear.',
    choose: 'Elige Hyper-V o VMware',
    review: 'Revisa los recursos y permisos',
    signin: 'Crea el ordenador e inicia sesión en ChatGPT',
    create: 'Crear un ordenador de trabajo',
    existing: 'Usar o importar un ordenador existente',
    manual: 'Conectar por SSH',
    checking: 'Buscando ordenadores y proveedores de máquinas virtuales…',
    found: 'Se encontró un ordenador de trabajo. Úsalo o impórtalo para conservar tus datos.',
    unsupported:
      'No se encontró un proveedor compatible. Activa Hyper-V, instala VMware o conéctate por SSH.',
    permissions:
      'La creación solo empieza tras tu confirmación. Windows puede solicitar permisos de administrador.',
    loadFailed:
      'No se pudieron comprobar los ordenadores existentes. Revísalos en los ajustes del ordenador de trabajo.',
    backupTitle: '¿Tienes una copia de seguridad de dant?',
    backupIntro: 'Trae tus datos de dant o configura un nuevo ordenador de trabajo.',
    importBackup: 'Importar copia de dant',
    noBackup: 'Sin copia: empezar de cero',
    back: 'Volver',
  },
  fr: {
    title: 'Commencez par préparer un ordinateur pour dant',
    intro:
      'dant travaille dans sa propre machine virtuelle Ubuntu. Configurez son ordinateur avant de commencer à discuter.',
    choose: 'Choisissez Hyper-V ou VMware',
    review: 'Vérifiez les ressources et les autorisations',
    signin: 'Créez l’ordinateur, puis connectez-vous à ChatGPT',
    create: 'Créer un ordinateur de travail',
    existing: 'Utiliser ou importer un ordinateur existant',
    manual: 'Se connecter par SSH',
    checking: 'Recherche des ordinateurs et des outils de virtualisation…',
    found:
      'Un ordinateur de travail a été trouvé. Utilisez-le ou importez-le pour conserver vos données.',
    unsupported:
      'Aucun outil compatible trouvé. Activez Hyper-V, installez VMware ou connectez-vous par SSH.',
    permissions:
      'La création commence uniquement après votre confirmation. Windows peut demander les droits administrateur.',
    loadFailed:
      'Impossible de vérifier les ordinateurs existants. Consultez les paramètres de l’ordinateur de travail.',
    backupTitle: 'Avez-vous une sauvegarde dant ?',
    backupIntro: 'Récupérez vos données dant ou configurez un nouvel ordinateur de travail.',
    importBackup: 'Importer une sauvegarde dant',
    noBackup: 'Sans sauvegarde : repartir de zéro',
    back: 'Retour',
  },
  de: {
    title: 'Bereite zuerst einen Computer für dant vor',
    intro:
      'dant arbeitet in einer eigenen virtuellen Ubuntu-Maschine. Richte den Arbeitscomputer ein, bevor du chattest.',
    choose: 'Hyper-V oder VMware auswählen',
    review: 'Ressourcen und Berechtigungen prüfen',
    signin: 'Computer erstellen und bei ChatGPT anmelden',
    create: 'Arbeitscomputer erstellen',
    existing: 'Vorhandenen Computer verwenden oder importieren',
    manual: 'Über SSH verbinden',
    checking: 'Vorhandene Computer und VM-Anbieter werden geprüft…',
    found:
      'Ein Arbeitscomputer wurde gefunden. Verwende oder importiere ihn, um deine Daten zu behalten.',
    unsupported:
      'Kein unterstützter VM-Anbieter gefunden. Aktiviere Hyper-V, installiere VMware oder verbinde dich über SSH.',
    permissions:
      'Die Erstellung beginnt erst nach deiner Bestätigung. Windows fragt möglicherweise nach Administratorrechten.',
    loadFailed:
      'Vorhandene Computer konnten nicht geprüft werden. Prüfe die Arbeitscomputer-Einstellungen.',
    backupTitle: 'Hast du ein dant-Backup?',
    backupIntro: 'Übernimm deine dant-Daten oder richte einen neuen Arbeitscomputer ein.',
    importBackup: 'dant-Backup importieren',
    noBackup: 'Ohne Backup neu beginnen',
    back: 'Zurück',
  },
  pt: {
    title: 'Primeiro, prepare um computador para o dant',
    intro:
      'O dant trabalha na sua própria máquina virtual Ubuntu. Configure o computador de trabalho antes de conversar.',
    choose: 'Escolha Hyper-V ou VMware',
    review: 'Reveja os recursos e as permissões',
    signin: 'Crie o computador e entre no ChatGPT',
    create: 'Criar computador de trabalho',
    existing: 'Usar ou importar um computador existente',
    manual: 'Ligar por SSH',
    checking: 'A procurar computadores existentes e fornecedores de VM…',
    found:
      'Foi encontrado um computador de trabalho. Use-o ou importe-o para manter os seus dados.',
    unsupported:
      'Não foi encontrado um fornecedor compatível. Ative o Hyper-V, instale o VMware ou ligue por SSH.',
    permissions:
      'A criação só começa após a sua confirmação. O Windows pode pedir permissões de administrador.',
    loadFailed:
      'Não foi possível verificar os computadores existentes. Consulte as definições do computador de trabalho.',
    backupTitle: 'Tem uma cópia de segurança do dant?',
    backupIntro: 'Traga os seus dados do dant ou configure um novo computador de trabalho.',
    importBackup: 'Importar cópia do dant',
    noBackup: 'Sem cópia — começar de novo',
    back: 'Voltar',
  },
  ru: {
    title: 'Сначала подготовьте компьютер для dant',
    intro:
      'dant работает в собственной виртуальной машине Ubuntu. Настройте рабочий компьютер перед началом чата.',
    choose: 'Выберите Hyper-V или VMware',
    review: 'Проверьте ресурсы и разрешения',
    signin: 'Создайте компьютер и войдите в ChatGPT',
    create: 'Создать рабочий компьютер',
    existing: 'Использовать или импортировать существующий',
    manual: 'Подключиться по SSH',
    checking: 'Проверяем компьютеры и средства виртуализации…',
    found: 'Найден рабочий компьютер. Используйте или импортируйте его, чтобы сохранить данные.',
    unsupported:
      'Совместимое средство виртуализации не найдено. Включите Hyper-V, установите VMware или подключитесь по SSH.',
    permissions:
      'Создание начнётся только после подтверждения. Windows может запросить права администратора.',
    loadFailed:
      'Не удалось проверить существующие компьютеры. Посмотрите настройки рабочего компьютера.',
    backupTitle: 'У вас есть резервная копия dant?',
    backupIntro: 'Перенесите свои данные dant или настройте новый рабочий компьютер.',
    importBackup: 'Импортировать копию dant',
    noBackup: 'Без копии — начать заново',
    back: 'Назад',
  },
  ar: {
    title: 'أولًا، جهّز حاسوبًا لـ dant',
    intro: 'يعمل dant داخل آلة Ubuntu افتراضية خاصة به. جهّز حاسوب العمل قبل بدء الدردشة.',
    choose: 'اختر Hyper-V أو VMware',
    review: 'راجع الموارد والأذونات',
    signin: 'أنشئ الحاسوب ثم سجّل الدخول إلى ChatGPT',
    create: 'إنشاء حاسوب عمل',
    existing: 'استخدام حاسوب موجود أو استيراده',
    manual: 'الاتصال عبر SSH',
    checking: 'جارٍ التحقق من الحواسيب وموفّري الآلات الافتراضية…',
    found: 'تم العثور على حاسوب عمل. استخدمه أو استورده للاحتفاظ ببياناتك.',
    unsupported: 'لم يُعثر على موفّر مدعوم. فعّل Hyper-V أو ثبّت VMware أو اتصل عبر SSH.',
    permissions: 'يبدأ الإنشاء بعد تأكيدك فقط. قد يطلب Windows إذن المسؤول.',
    loadFailed: 'تعذّر التحقق من الحواسيب الموجودة. يمكنك مراجعتها في إعدادات حاسوب العمل.',
    backupTitle: 'هل لديك نسخة احتياطية من dant؟',
    backupIntro: 'انقل بيانات dant معك أو جهّز حاسوب عمل جديدًا.',
    importBackup: 'استيراد نسخة dant احتياطية',
    noBackup: 'لا توجد نسخة — البدء من جديد',
    back: 'رجوع',
  },
  hi: {
    title: 'पहले dant के लिए एक कंप्यूटर तैयार करें',
    intro:
      'dant अपनी Ubuntu वर्चुअल मशीन में काम करता है। चैट शुरू करने से पहले उसका कार्य कंप्यूटर तैयार करें।',
    choose: 'Hyper-V या VMware चुनें',
    review: 'संसाधनों और अनुमतियों की समीक्षा करें',
    signin: 'कंप्यूटर बनाएँ और ChatGPT में साइन इन करें',
    create: 'कार्य कंप्यूटर बनाएँ',
    existing: 'मौजूदा कंप्यूटर इस्तेमाल या आयात करें',
    manual: 'SSH से कनेक्ट करें',
    checking: 'मौजूदा कंप्यूटर और VM प्रदाताओं की जाँच हो रही है…',
    found: 'एक कार्य कंप्यूटर मिला है। अपना डेटा बनाए रखने के लिए उसे इस्तेमाल या आयात करें।',
    unsupported:
      'कोई समर्थित VM प्रदाता नहीं मिला। Hyper-V चालू करें, VMware इंस्टॉल करें या SSH से कनेक्ट करें।',
    permissions: 'निर्माण आपकी पुष्टि के बाद ही शुरू होगा। Windows प्रशासक की अनुमति माँग सकता है।',
    loadFailed: 'मौजूदा कंप्यूटरों की जाँच नहीं हो सकी। कार्य कंप्यूटर की सेटिंग में देखें।',
    backupTitle: 'क्या आपके पास dant का बैकअप है?',
    backupIntro: 'अपना dant डेटा साथ लाएँ या नया कार्य कंप्यूटर तैयार करें।',
    importBackup: 'dant बैकअप आयात करें',
    noBackup: 'बैकअप नहीं है — नई शुरुआत करें',
    back: 'वापस',
  },
  id: {
    title: 'Pertama, siapkan komputer untuk dant',
    intro:
      'dant bekerja di mesin virtual Ubuntu miliknya sendiri. Siapkan komputer kerja sebelum mulai mengobrol.',
    choose: 'Pilih Hyper-V atau VMware',
    review: 'Tinjau sumber daya dan izin',
    signin: 'Buat komputer, lalu masuk ke ChatGPT',
    create: 'Buat komputer kerja',
    existing: 'Gunakan atau impor komputer yang ada',
    manual: 'Hubungkan melalui SSH',
    checking: 'Memeriksa komputer dan penyedia VM yang ada…',
    found: 'Komputer kerja ditemukan. Gunakan atau impor untuk mempertahankan data Anda.',
    unsupported:
      'Tidak ada penyedia VM yang didukung. Aktifkan Hyper-V, instal VMware, atau hubungkan melalui SSH.',
    permissions:
      'Pembuatan hanya dimulai setelah Anda mengonfirmasi. Windows mungkin meminta izin administrator.',
    loadFailed: 'Komputer yang ada tidak dapat diperiksa. Lihat di pengaturan komputer kerja.',
    backupTitle: 'Apakah Anda memiliki cadangan dant?',
    backupIntro: 'Bawa data dant Anda atau siapkan komputer kerja baru.',
    importBackup: 'Impor cadangan dant',
    noBackup: 'Tanpa cadangan — mulai baru',
    back: 'Kembali',
  },
  ms: {
    title: 'Mula-mula, sediakan komputer untuk dant',
    intro:
      'dant bekerja dalam mesin maya Ubuntu sendiri. Sediakan komputer kerja sebelum mula berbual.',
    choose: 'Pilih Hyper-V atau VMware',
    review: 'Semak sumber dan kebenaran',
    signin: 'Cipta komputer, kemudian log masuk ke ChatGPT',
    create: 'Cipta komputer kerja',
    existing: 'Guna atau import komputer sedia ada',
    manual: 'Sambung melalui SSH',
    checking: 'Menyemak komputer sedia ada dan penyedia VM…',
    found: 'Komputer kerja ditemui. Guna atau importnya untuk mengekalkan data anda.',
    unsupported:
      'Tiada penyedia VM yang disokong. Aktifkan Hyper-V, pasang VMware, atau sambung melalui SSH.',
    permissions:
      'Penciptaan hanya bermula selepas pengesahan anda. Windows mungkin meminta kebenaran pentadbir.',
    loadFailed: 'Komputer sedia ada tidak dapat disemak. Lihat dalam tetapan komputer kerja.',
    backupTitle: 'Adakah anda mempunyai sandaran dant?',
    backupIntro: 'Bawa data dant anda atau sediakan komputer kerja baharu.',
    importBackup: 'Import sandaran dant',
    noBackup: 'Tiada sandaran — mula baharu',
    back: 'Kembali',
  },
  it: {
    title: 'Per prima cosa, prepara un computer per dant',
    intro:
      'dant lavora nella propria macchina virtuale Ubuntu. Configura il computer di lavoro prima di iniziare a chattare.',
    choose: 'Scegli Hyper-V o VMware',
    review: 'Controlla risorse e autorizzazioni',
    signin: 'Crea il computer e accedi a ChatGPT',
    create: 'Crea un computer di lavoro',
    existing: 'Usa o importa un computer esistente',
    manual: 'Connetti tramite SSH',
    checking: 'Verifica dei computer esistenti e dei provider VM…',
    found: 'È stato trovato un computer di lavoro. Usalo o importalo per conservare i tuoi dati.',
    unsupported:
      'Nessun provider VM supportato trovato. Abilita Hyper-V, installa VMware o connettiti tramite SSH.',
    permissions:
      'La creazione inizia solo dopo la tua conferma. Windows potrebbe richiedere i privilegi di amministratore.',
    loadFailed:
      'Impossibile verificare i computer esistenti. Consulta le impostazioni del computer di lavoro.',
    backupTitle: 'Hai un backup di dant?',
    backupIntro: 'Porta con te i dati di dant oppure configura un nuovo computer di lavoro.',
    importBackup: 'Importa un backup di dant',
    noBackup: 'Nessun backup — ricomincia da zero',
    back: 'Indietro',
  },
  tr: {
    title: 'Önce dant için bir bilgisayar hazırlayın',
    intro:
      'dant kendi Ubuntu sanal makinesinde çalışır. Sohbete başlamadan önce iş bilgisayarını kurun.',
    choose: 'Hyper-V veya VMware seçin',
    review: 'Kaynakları ve izinleri gözden geçirin',
    signin: 'Bilgisayarı oluşturup ChatGPT’de oturum açın',
    create: 'İş bilgisayarı oluştur',
    existing: 'Mevcut bilgisayarı kullan veya içe aktar',
    manual: 'SSH ile bağlan',
    checking: 'Mevcut bilgisayarlar ve VM sağlayıcıları denetleniyor…',
    found:
      'Mevcut bir iş bilgisayarı bulundu. Verilerinizi korumak için onu kullanın veya içe aktarın.',
    unsupported:
      'Desteklenen VM sağlayıcısı bulunamadı. Hyper-V’yi etkinleştirin, VMware yükleyin veya SSH ile bağlanın.',
    permissions: 'Oluşturma yalnızca onayınızdan sonra başlar. Windows yönetici izni isteyebilir.',
    loadFailed:
      'Mevcut bilgisayarlar denetlenemedi. İş bilgisayarı ayarlarından gözden geçirebilirsiniz.',
    backupTitle: 'dant yedeğiniz var mı?',
    backupIntro: 'dant verilerinizi yanınızda getirin veya yeni bir iş bilgisayarı kurun.',
    importBackup: 'dant yedeğini içe aktar',
    noBackup: 'Yedek yok — yeni başla',
    back: 'Geri',
  },
};
