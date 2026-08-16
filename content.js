/**
 * Boss直聘岗位任职要求共性分析 - Content Script v5.0
 *
 * 数据采集策略：
 * 1. 自动滚动加载 30+ 岗位卡片
 * 2. 逐个点击岗位卡片，打开右侧详情面板
 * 3. 从详情面板提取完整的职位描述（含岗位职责+任职要求）
 * 4. 按段落分离：职责段 → RESPONSIBILITY_KEYWORDS 匹配
 *              要求段 → REQUIREMENT_KEYWORDS + 动词模式匹配
 * 5. 标签技能 → 直接归入 requirements 统计
 *
 * 动词模式提取：匹配 "熟悉/掌握/深入了解/精通 + 技术名" 结构
 */

// ==================== 配置项 ====================

const JOB_LIST_PAGE_PATTERNS = [
  '/web/geek/job',
  '/web/geek/jobs'
];

// 多层次选择器：从精确到宽松
const JOB_CARD_SELECTORS = [
  // 精确类名
  '.job-card-wrapper',
  '.job-list-item',
  '.job-card',
  '.search-job-result .job-card-wrapper',
  '.job-list ul li',
  'li[ka="search_list"]',
  '.job-item',
  // 宽松匹配
  '[class*="job-card"]',
  '[class*="JobCard"]',
  '[class*="job_list"]',
  '[class*="job-list"]',
  '[class*="search-list"]',
  // 数据属性
  'li[data-jid]',
  'div[data-jid]',
  'a[href*="/job/"]',
  // 结构匹配
  '.search-job-result > div',
  '#main .job-card',
  '.job-list-container > div'
];

const JOB_TITLE_SELECTORS = [
  '.job-name',
  '.job-card-name',
  'a.job-name',
  '[class*="job-name"]',
  '[class*="JobName"]',
  '[class*="title"]',
  'a[href*="/job/"]'
];

const SKILL_TAG_SELECTORS = [
  '.tag-container .tag',
  '.tags .tag',
  '.job-tags .tag',
  'li.tag',
  '.tag-list .tag',
  '.job-card-tags .tag',
  '[class*="tag"]',
  '[class*="Tag"]',
  '[class*="skill"]',
  'span[class*="tag"]'
];

// 详情面板选择器（右侧分屏）
const DETAIL_PANEL_SELECTORS = [
  '.job-detail',
  '.job-info',
  '.job-card-body',
  '[class*="detail"]',
  '[class*="job-detail"]',
  '.sidebar-job',
  '.job-desc',
  'article[class*="job"]'
];

// 详情面板中职位描述区域选择器
const DESCRIPTION_SELECTORS = [
  '.job-detail-desc',
  '.job-desc-text',
  '.job-description',
  '[class*="desc"]',
  '[class*="description"]',
  '.job-info .text',
  '.detail-item'
];

// 目标岗位数量
const TARGET_JOB_COUNT = 30;
// 详情提取数量（最多30个，全部提取详情）
const MAX_DETAIL_EXTRACT = 30;

// 滚动配置
const SCROLL_DELAY = 500;
const MAX_SCROLL_ATTEMPTS = 30;
// 连续无新增时的最大重试次数（用于检测到底部）
const MAX_STALE_ATTEMPTS = 3;
// 详情面板加载等待时间
const DETAIL_LOAD_DELAY = 1000;

// ==================== 动词+技能 模式 ====================
// 匹配 "熟悉/掌握/深入了解/精通/熟练使用/会使用 + [技术名]" 的结构

const SKILL_VERBS = [
  '熟悉', '掌握', '深入了解', '深入理解', '精通', '熟练使用',
  '会使用', '熟练掌握', '了解', '具备', '有', '能够', '擅长'
];

/**
 * 从文本中提取 "动词 + 技能名" 组合
 * 仅返回能匹配到 REQUIREMENT_KEYWORDS 词典的技能（降噪）
 */
function extractSkillVerbPatterns(text) {
  const matched = new Set();

  // 通用模式：匹配动词后跟技术名
  const verbPattern = SKILL_VERBS.join('|');

  // 匹配 "动词 + 技术" 结构
  const regex = new RegExp(
    `(${verbPattern})\\s*[：:，,、]?\\s*([\\u4e00-\\u9fa5A-Za-z][\\u4e00-\\u9fa5A-Za-z0-9#+./\\s-]{1,30})`,
    'g'
  );

  let match;
  while ((match = regex.exec(text)) !== null) {
    const skillName = match[2].trim();
    if (skillName.length >= 2 && skillName.length <= 30) {
      // 降噪：只保留能匹配到词典的技能名
      const cat = matchTagToCategory(skillName);
      if (cat) {
        matched.add(skillName);
      }
    }
  }

  // 特殊模式：动词 + 冒号 + 列举多项技术
  const multiSkillRegex = new RegExp(
    `(${verbPattern})\\s*[：:]\\s*([\\u4e00-\\u9fa5A-Za-z0-9#+./\\s、,，]+)`,
    'g'
  );

  while ((match = multiSkillRegex.exec(text)) !== null) {
    const skillListStr = match[2];
    const skills = skillListStr.split(/[、,，]/).map(s => s.trim()).filter(s => s.length > 0 && s.length < 20);
    skills.forEach(s => {
      const cleaned = s.replace(/^(中的|至少|任意|任一种)/, '').trim();
      // 降噪：只保留能匹配到词典的
      const cat = matchTagToCategory(cleaned);
      if (cat && cleaned.length >= 1) {
        matched.add(cleaned);
      }
    });
  }

  return Array.from(matched);
}

// ==================== 段落分离 ====================

/**
 * 将详情文本分离为 "岗位职责" 和 "任职要求" 两个段落
 * Boss直聘详情通常以 "职位描述"/"岗位职责" 和 "职位要求"/"任职要求" 分段
 */
function splitDetailText(text) {
  const sections = {
    responsibility: '',  // 岗位职责段落
    requirement: '',     // 任职要求段落
    raw: text            // 原始文本
  };

  if (!text) return sections;

  // 查找分段标记
  const respHeaders = ['岗位职责', '职位描述', '岗位描述', '工作内容', '日常工作'];
  const reqHeaders = ['任职要求', '职位要求', '岗位要求', '任职资格', '要求'];

  // 尝试找到各段的起始位置
  let respStart = -1;
  let reqStart = -1;

  for (const header of respHeaders) {
    const idx = text.indexOf(header);
    if (idx !== -1 && (respStart === -1 || idx < respStart)) {
      respStart = idx;
    }
  }

  for (const header of reqHeaders) {
    const idx = text.indexOf(header);
    if (idx !== -1 && (reqStart === -1 || idx < reqStart)) {
      reqStart = idx;
    }
  }

  // 根据起止位置提取各段
  if (respStart !== -1 && reqStart !== -1 && reqStart > respStart) {
    sections.responsibility = text.substring(respStart, reqStart).trim();
    sections.requirement = text.substring(reqStart).trim();
  } else if (respStart !== -1) {
    sections.responsibility = text.substring(respStart).trim();
  } else if (reqStart !== -1) {
    sections.requirement = text.substring(reqStart).trim();
  }

  // 如果没找到分段，把全部文本放入 requirement（有要求关键词的概率更高）
  if (!sections.responsibility && !sections.requirement) {
    sections.requirement = text;
  }

  return sections;
}

// ==================== 精准关键词词典 ====================

const RESPONSIBILITY_KEYWORDS = [
  // 数据/大数据方向
  { keywords: ['数据仓库建设', '数据仓库', '数仓建设', '数据平台'], category: '数据仓库建设' },
  { keywords: ['数据处理', 'ETL', '清洗数据', '数据清洗', '数据加工'], category: '数据处理/ETL' },
  { keywords: ['数据分析', '数据分析工作', '数据挖掘', '数据建模'], category: '数据分析/建模' },
  { keywords: ['数据服务', '数据产品', '数据中台', '数据治理'], category: '数据服务/治理' },
  { keywords: ['实时数据', '实时计算', '实时处理', '流式计算'], category: '实时数据处理' },
  { keywords: ['离线数据', '离线计算', '批处理', '离线任务'], category: '离线数据处理' },
  { keywords: ['指标体系', '指标开发', '数据指标', '业务指标'], category: '指标体系建设' },

  // 开发方向
  { keywords: ['接口开发', 'API开发', 'API设计', 'RESTful', '微服务接口'], category: '接口/API开发' },
  { keywords: ['前端页面', '前端开发', '页面开发', '组件开发', 'UI组件'], category: '前端页面开发' },
  { keywords: ['后端开发', '服务端开发', '服务端', '后端服务'], category: '后端服务开发' },
  { keywords: ['全栈开发', '全栈'], category: '全栈开发' },
  { keywords: ['核心系统', '核心模块', '核心业务', '核心功能'], category: '核心系统开发' },
  { keywords: ['业务系统', '业务模块', '业务功能'], category: '业务系统开发' },
  { keywords: ['系统开发', '应用开发', '功能开发', '模块开发'], category: '系统/模块开发' },

  // 架构与设计
  { keywords: ['架构设计', '系统架构', '技术架构', '架构方案'], category: '架构设计' },
  { keywords: ['技术方案', '方案设计', '方案评审', '技术选型'], category: '技术方案设计' },
  { keywords: ['技术预研', '技术调研', '前沿技术', '新技术调研'], category: '技术预研/调研' },

  // 算法/AI
  { keywords: ['算法开发', '算法实现', '算法研究', '算法优化'], category: '算法开发' },
  { keywords: ['机器学习', '深度学习', '模型训练', '模型开发', '模型优化'], category: '机器学习/模型' },
  { keywords: ['推荐算法', '搜索算法', '排序算法', 'NLP', '自然语言处理'], category: '算法应用' },
  { keywords: ['LLM', '大语言模型', '大模型', 'Prompt', 'Agent', '智能体'], category: '大模型应用' },

  // 工程与质量
  { keywords: ['性能优化', '性能调优', '高并发', '高可用'], category: '性能优化' },
  { keywords: ['代码优化', '代码重构', '重构', '代码质量'], category: '代码重构' },
  { keywords: ['测试开发', '自动化测试', '测试用例', '接口测试'], category: '测试开发' },
  { keywords: ['CI/CD', '持续集成', '持续交付', 'DevOps'], category: 'CI/CD/DevOps' },

  // 部署与运维
  { keywords: ['部署', '上线', '发布', '灰度发布'], category: '部署上线' },
  { keywords: ['运维', '监控', '告警', '故障排查'], category: '运维监控' },
  { keywords: ['容器化部署', '容器化', '编排'], category: '容器化部署' },

  // 项目与协作
  { keywords: ['项目管理', '项目负责', '主导项目', '项目推进'], category: '项目管理' },
  { keywords: ['跨团队', '跨部门', '协作', '对接', '沟通'], category: '跨团队协作' },
  { keywords: ['需求分析', '需求拆解', '需求评审', '产品需求'], category: '需求分析' },
  { keywords: ['文档编写', '技术文档', '设计文档', '撰写文档'], category: '文档撰写' },

  // 安全方向
  { keywords: ['安全开发', '安全审计', '代码审计', '安全加固'], category: '安全开发' },
  { keywords: ['渗透测试', '漏洞挖掘', '红蓝对抗', '安全演练'], category: '攻防测试' },

  // 游戏方向
  { keywords: ['游戏开发', '游戏逻辑', '玩法开发', '战斗系统'], category: '游戏开发' },
  { keywords: ['关卡设计', '数值策划', '系统策划', '剧情策划'], category: '游戏策划' },

  // 教学/研究
  { keywords: ['教学', '授课', '课程设计', '培养'], category: '教学/培训' },
  { keywords: ['研究', '实验室', '科研', '论文'], category: '科研/研究' }
];

const REQUIREMENT_KEYWORDS = [
  // 学历要求
  { keywords: ['本科', '硕士', '博士', '大专', '中专'], category: '本科及以上' },
  { keywords: ['985', '211', '双一流'], category: '985/211院校' },

  // 专业要求
  { keywords: ['计算机', '软件工程', '人工智能', '信息安全', '网络安全'], category: '计算机相关专业' },
  { keywords: ['数据科学', '数据工程', '大数据', '统计学', '数学'], category: '数据/统计相关专业' },
  { keywords: ['电子信息', '通信工程', '自动化', '测控'], category: '电子/通信相关专业' },

  // 编程语言
  { keywords: ['Java', 'java'], category: 'Java' },
  { keywords: ['Python', 'python'], category: 'Python' },
  { keywords: ['Scala', 'scala'], category: 'Scala' },
  { keywords: ['C++', 'c++'], category: 'C++' },
  { keywords: ['C语言', 'c语言'], category: 'C语言' },
  { keywords: ['C#', 'c#'], category: 'C#' },
  { keywords: ['JavaScript', 'javascript'], category: 'JavaScript' },
  { keywords: ['TypeScript', 'typescript'], category: 'TypeScript' },
  { keywords: ['Go语言', 'Golang', 'golang'], category: 'Go' },
  { keywords: ['Rust', 'rust'], category: 'Rust' },
  { keywords: ['PHP', 'php'], category: 'PHP' },
  { keywords: ['Ruby', 'ruby'], category: 'Ruby' },
  { keywords: ['Swift', 'swift'], category: 'Swift' },
  { keywords: ['Kotlin', 'kotlin'], category: 'Kotlin' },
  { keywords: ['SQL', 'sql'], category: 'SQL' },
  { keywords: ['R语言', 'R语言'], category: 'R' },

  // 大数据技术栈
  { keywords: ['Hadoop', 'hadoop'], category: 'Hadoop' },
  { keywords: ['Spark', 'spark'], category: 'Spark' },
  { keywords: ['Flink', 'flink'], category: 'Flink' },
  { keywords: ['Kafka', 'kafka'], category: 'Kafka' },
  { keywords: ['Hive', 'hive'], category: 'Hive' },
  { keywords: ['HBase', 'hbase'], category: 'HBase' },
  { keywords: ['Zookeeper', 'zookeeper'], category: 'ZooKeeper' },
  { keywords: ['Presto', 'presto'], category: 'Presto' },
  { keywords: ['ClickHouse', 'clickhouse'], category: 'ClickHouse' },
  { keywords: ['Doris', 'doris'], category: 'Doris' },

  // 数据库
  { keywords: ['MySQL', 'mysql'], category: 'MySQL' },
  { keywords: ['PostgreSQL', 'postgresql'], category: 'PostgreSQL' },
  { keywords: ['Redis', 'redis'], category: 'Redis' },
  { keywords: ['MongoDB', 'mongodb'], category: 'MongoDB' },
  { keywords: ['Oracle', 'oracle'], category: 'Oracle' },
  { keywords: ['Elasticsearch', 'elasticsearch'], category: 'Elasticsearch' },
  { keywords: ['Cassandra', 'cassandra'], category: 'Cassandra' },

  // 前端框架
  { keywords: ['React', 'react'], category: 'React' },
  { keywords: ['Vue', 'vue'], category: 'Vue' },
  { keywords: ['Angular', 'angular'], category: 'Angular' },
  { keywords: ['Node.js', 'NodeJS', 'nodejs'], category: 'Node.js' },

  // 后端框架
  { keywords: ['Spring', 'Spring Boot', 'SpringCloud'], category: 'Spring' },
  { keywords: ['Django', 'django'], category: 'Django' },
  { keywords: ['Flask', 'flask'], category: 'Flask' },
  { keywords: ['gRPC', 'grpc'], category: 'gRPC' },

  // 中间件
  { keywords: ['RabbitMQ', 'rabbitmq'], category: 'RabbitMQ' },
  { keywords: ['RocketMQ', 'rocketmq'], category: 'RocketMQ' },
  { keywords: ['Nginx', 'nginx'], category: 'Nginx' },
  { keywords: ['Tomcat', 'tomcat'], category: 'Tomcat' },

  // 云原生/DevOps
  { keywords: ['Docker', 'docker'], category: 'Docker' },
  { keywords: ['Kubernetes', 'kubernetes', 'K8s'], category: 'Kubernetes' },
  { keywords: ['Jenkins', 'jenkins'], category: 'Jenkins' },
  { keywords: ['GitLab', 'gitlab'], category: 'GitLab' },
  { keywords: ['AWS', 'aws'], category: 'AWS' },
  { keywords: ['阿里云', '腾讯云', '华为云'], category: '云平台' },

  // 操作系统
  { keywords: ['Linux', 'linux'], category: 'Linux' },
  { keywords: ['Windows', 'windows'], category: 'Windows' },

  // 工具
  { keywords: ['Git', 'git'], category: 'Git' },
  { keywords: ['Maven', 'maven'], category: 'Maven' },
  { keywords: ['Gradle', 'gradle'], category: 'Gradle' },

  // 软技能
  { keywords: ['沟通能力', '团队协作', '合作能力'], category: '沟通/协作' },
  { keywords: ['学习能力', '自学能力', '自驱力'], category: '学习能力' },
  { keywords: ['独立完成', '独立开发', '独立解决'], category: '独立能力' },
  { keywords: ['抗压能力', '抗压'], category: '抗压能力' },
  { keywords: ['责任心', '认真负责'], category: '责任心' },

  // 经验/年限
  { keywords: ['年以上', '年开发经验', '年工作经验'], category: '工作经验要求' },
  { keywords: ['初级', '中级', '高级', '资深', '专家'], category: '职级要求' },

  // 游戏引擎
  { keywords: ['Unity', 'unity'], category: 'Unity' },
  { keywords: ['Unreal', 'unreal', 'UE4', 'UE5'], category: 'Unreal Engine' },
  { keywords: ['Cocos', 'cocos'], category: 'Cocos' },

  // AI/ML 技术栈
  { keywords: ['TensorFlow', 'tensorflow'], category: 'TensorFlow' },
  { keywords: ['PyTorch', 'pytorch'], category: 'PyTorch' },
  { keywords: ['Pandas', 'pandas'], category: 'Pandas' },
  { keywords: ['NumPy', 'numpy'], category: 'NumPy' },
  { keywords: ['Scikit-learn', 'scikit-learn', 'sklearn'], category: 'Scikit-learn' },

  // 安全专项
  { keywords: ['网络安全', 'Web安全'], category: '网络安全' },
  { keywords: ['渗透测试'], category: '渗透测试' },

  // 数据仓库专项
  { keywords: ['数据仓库', '数仓', '数据建模', '数据治理'], category: '数据仓库' },
  { keywords: ['ETL', '数仓开发'], category: 'ETL/数仓开发' }
];

// 技能标签 → 词典分类的快速映射
// 用于将卡片标签匹配到 REQUIREMENT_KEYWORDS 分类
const TAG_TO_CATEGORY = {};
REQUIREMENT_KEYWORDS.forEach(entry => {
  entry.keywords.forEach(kw => {
    TAG_TO_CATEGORY[kw.toLowerCase()] = entry.category;
  });
});

// ==================== 状态变量 ====================

let isExtracting = false;
let autoScrolling = false;
let lastJobType = '';

// ==================== 核心工具函数 ====================

function isJobListPage() {
  const currentPath = window.location.pathname;
  return JOB_LIST_PAGE_PATTERNS.some(pattern =>
    currentPath.includes(pattern)
  );
}

function getCurrentJobType() {
  const urlParams = new URLSearchParams(window.location.search);
  const query = urlParams.get('query') || '';
  const industry = urlParams.get('industry') || '';
  const position = urlParams.get('position') || '';
  const city = urlParams.get('city') || '';
  return `${query}|${industry}|${position}|${city}`;
}

function waitForElement(selector, timeout = 5000, parent = document) {
  return new Promise((resolve) => {
    const found = parent.querySelector(selector);
    if (found) { resolve(found); return; }

    const startTime = Date.now();
    const observer = new MutationObserver(() => {
      const el = parent.querySelector(selector);
      if (el) {
        observer.disconnect();
        resolve(el);
      }
      if (Date.now() - startTime > timeout) {
        observer.disconnect();
        resolve(null);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

// ==================== 关键词匹配 ====================

/**
 * 从文本提取职责类关键词
 */
function extractResponsibilitiesFromText(textContent) {
  const matched = new Set();
  const lowerText = textContent.toLowerCase();

  RESPONSIBILITY_KEYWORDS.forEach(entry => {
    for (const keyword of entry.keywords) {
      if (lowerText.includes(keyword.toLowerCase())) {
        matched.add(entry.category);
        break;
      }
    }
  });

  return Array.from(matched);
}

/**
 * 从文本提取要求类关键词（技能/技术）
 * 优先使用 REQUIREMENT_KEYWORDS 词典匹配
 */
function extractRequirementsFromText(textContent) {
  const matched = new Set();
  const lowerText = textContent.toLowerCase();

  REQUIREMENT_KEYWORDS.forEach(entry => {
    for (const keyword of entry.keywords) {
      const lowerKeyword = keyword.toLowerCase();

      // 对短技术名做边界匹配
      if (lowerKeyword.length <= 5 && !lowerKeyword.includes('年以上')) {
        const escaped = lowerKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(
          `(?:^|[\\s,.;:，。；：、()（）\\[\\]【】'"\\s])${escaped}(?:$|[\\s,.;:，。；：、()（）\\[\\]【】'"\\s])`,
          'i'
        );
        if (pattern.test(textContent)) {
          matched.add(entry.category);
          break;
        }
      } else {
        if (lowerText.includes(lowerKeyword)) {
          matched.add(entry.category);
          break;
        }
      }
    }
  });

  return Array.from(matched);
}

/**
 * 从标签文本匹配到 REQUIREMENT 分类
 */
function matchTagToCategory(tagText) {
  const lower = tagText.toLowerCase().trim();
  // 直接匹配
  if (TAG_TO_CATEGORY[lower]) {
    return TAG_TO_CATEGORY[lower];
  }
  // 模糊匹配（标签可能是 "Java开发" 这种形式）
  for (const [keyword, category] of Object.entries(TAG_TO_CATEGORY)) {
    if (lower.includes(keyword)) {
      return category;
    }
  }
  return null;
}

// ==================== 岗位卡片检测引擎 ====================

/**
 * 通过多层策略查找岗位卡片
 * 策略1: 预定义选择器
 * 策略2: 通用结构 + 文本特征匹配
 */
function findAllJobCards() {
  let cards = [];
  const seen = new Set();

  // 策略1: 用预定义选择器查找
  for (const selector of JOB_CARD_SELECTORS) {
    try {
      const elements = document.querySelectorAll(selector);
      if (elements.length > 0 && elements.length <= 200) {
        elements.forEach(el => {
          const key = el.outerHTML.substring(0, 200);
          if (!seen.has(key) && isValidJobCard(el)) {
            seen.add(key);
            cards.push(el);
          }
        });
        if (cards.length >= 5) break;  // 找到足够的就停
      }
    } catch (e) { /* 忽略无效选择器 */ }
  }

  // 策略2: 如果策略1没找到，用通用特征匹配
  if (cards.length === 0) {
    console.log('[Boss分析器] 策略1无结果，启用策略2：通用特征匹配');
    cards = findJobCardsByFeature();
  }

  // 去重
  const uniqueCards = [];
  const uniqueKeys = new Set();
  cards.forEach(card => {
    const key = card.textContent.substring(0, 80);
    if (!uniqueKeys.has(key)) {
      uniqueKeys.add(key);
      uniqueCards.push(card);
    }
  });

  console.log(`[Boss分析器] 检测到 ${uniqueCards.length} 个岗位卡片`);
  return uniqueCards;
}

/**
 * 判断一个元素是否为有效岗位卡片
 */
function isValidJobCard(el) {
  const text = (el.textContent || '').trim();
  if (text.length < 10) return false;
  if (text.length > 2000) return false;

  // 必须包含岗位标题（一般较长）
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const longLines = lines.filter(l => l.length > 4 && l.length < 50);

  // 岗位卡片通常包含：标题(3-30字) + 薪资 + 技能标签 + 公司/城市
  // 检查是否有"元/天"、"元/月"、"K"等薪资特征
  const hasSalary = /[\d]+[-][\d]+元/.test(text) || /[\d]+[-][\d]+K/i.test(text);
  // 检查是否有多行结构
  const hasMultipleLines = longLines.length >= 2;

  return hasSalary || hasMultipleLines;
}

/**
 * 通过通用特征查找岗位卡片（不依赖具体选择器）
 */
function findJobCardsByFeature() {
  const cards = [];

  // 查找所有 li 和 div 元素
  const candidates = document.querySelectorAll('li, div');

  candidates.forEach(el => {
    if (el.children.length > 10) return;  // 排除容器
    if (el.children.length === 0) return;  // 排除纯文本

    const text = (el.textContent || '').trim();
    if (text.length < 30 || text.length > 500) return;

    // 岗位卡片特征：包含薪资、日期、学历等
    const hasSalary = /[\d]+[-][\d]+元|[\d]+[-][\d]+K/i.test(text);
    const hasDegree = /本科|硕士|大专|博士/.test(text);
    const hasCity = /北京|上海|广州|深圳|杭州|成都|武汉|西安|南京/.test(text);
    const hasDays = /\d+天\/周|\d+周/.test(text);

    // 至少命中2个特征
    const score = [hasSalary, hasDegree, hasCity, hasDays].filter(Boolean).length;
    if (score >= 2) {
      cards.push(el);
    }
  });

  // 限制数量
  return cards.slice(0, 50);
}

// ==================== 岗位卡片提取（基础信息） ====================

function extractJobFromCard(card) {
  let jobTitle = '';
  for (const selector of JOB_TITLE_SELECTORS) {
    const titleEl = card.querySelector(selector);
    if (titleEl) {
      jobTitle = titleEl.textContent.trim();
      break;
    }
  }

  if (!jobTitle) {
    const linkEl = card.querySelector('a[href*="job"]');
    if (linkEl) {
      jobTitle = linkEl.textContent.trim();
    }
  }

  if (!jobTitle || jobTitle.length < 2) {
    return null;
  }

  // 提取标签技能并映射到分类
  const tagCategories = new Set();
  const rawSkills = new Set();

  for (const selector of SKILL_TAG_SELECTORS) {
    const tagElements = card.querySelectorAll(selector);
    tagElements.forEach(el => {
      const skill = el.textContent.trim();
      if (skill && skill.length <= 30) {
        rawSkills.add(skill);
        const category = matchTagToCategory(skill);
        if (category) {
          tagCategories.add(category);
        }
      }
    });
  }

  return {
    title: jobTitle,
    skills: Array.from(rawSkills),
    tagCategories: Array.from(tagCategories),
    responsibilities: [],  // 等详情提取后填充
    requirements: [],     // 等详情提取后填充
    url: window.location.href,
    timestamp: Date.now()
  };
}

// ==================== 详情面板提取 ====================

/**
 * 点击岗位卡片并提取详情面板文本
 * 安全策略：检测是否导航到新页面，只在分屏模式下提取
 */
async function extractDetailForCard(card) {
  const urlBefore = window.location.href;

  // 点击卡片打开详情
  const clickTarget = card.querySelector('a, .job-name, .job-card-left') || card;

  try {
    clickTarget.click();
  } catch (e) {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    clickTarget.dispatchEvent(event);
  }

  // 等待详情面板加载
  await new Promise(r => setTimeout(r, DETAIL_LOAD_DELAY));

  // 检查是否发生了页面导航（Boss直聘有时会跳转而非分屏）
  const urlAfter = window.location.href;
  if (urlAfter !== urlBefore) {
    // 页面导航了，使用 history.back() 返回
    console.warn('[Boss分析器] 点击导致页面导航，返回列表页');
    window.history.back();
    await new Promise(r => setTimeout(r, 1500));
    return null;
  }

  // === 多策略查找详情面板 ===
  let detailPanel = null;

  // 策略1: 尝试预定义选择器
  for (const selector of DETAIL_PANEL_SELECTORS) {
    const el = document.querySelector(selector);
    if (el && el.textContent && el.textContent.trim().length > 50) {
      detailPanel = el;
      break;
    }
  }

  // 策略2: 查找右侧面板区域
  if (!detailPanel) {
    // Boss直聘分屏模式：右侧通常有一个独立容器
    const rightContainer = document.querySelector(
      '.search-job-result + div[class], ' +
      '[class*="detail-panel"], ' +
      '[class*="right-panel"], ' +
      '[class*="sidebar-job"], ' +
      'div[class*="job-detail"]'
    );
    if (rightContainer && rightContainer.textContent && rightContainer.textContent.trim().length > 100) {
      detailPanel = rightContainer;
    }
  }

  // 策略3: 查找包含 "职位描述" 或 "任职要求" 文本的元素
  if (!detailPanel) {
    const allElements = document.querySelectorAll('div, section, article, aside');
    let bestMatch = null;
    let bestLength = 0;

    for (const el of allElements) {
      const text = el.textContent || '';
      // 检查是否包含关键标题
      const hasResp = text.includes('职位描述') || text.includes('岗位职责');
      const hasReq = text.includes('任职要求') || text.includes('职位要求');
      if ((hasResp || hasReq) && text.length > bestLength && text.length < 50000) {
        // 选择最内层的有效容器（排除 body 级别的）
        if (el.tagName !== 'BODY' && el.children.length < 20) {
          bestMatch = el;
          bestLength = text.length;
        }
      }
    }
    detailPanel = bestMatch;
  }

  if (!detailPanel) {
    return null;
  }

  // 获取完整文本
  const fullText = detailPanel.textContent.trim();
  if (fullText.length < 30) {
    return null;
  }

  // 分离段落
  const sections = splitDetailText(fullText);

  // 从各段提取关键词
  const respFromDetail = extractResponsibilitiesFromText(sections.responsibility);
  const reqFromDetail = extractRequirementsFromText(sections.requirement);

  // 从要求段用动词模式提取补充（已内置降噪）
  const verbSkills = extractSkillVerbPatterns(sections.requirement);
  const verbCategories = new Set();
  verbSkills.forEach(skill => {
    const cat = matchTagToCategory(skill);
    if (cat) verbCategories.add(cat);
  });

  return {
    fullText,
    sections,
    respFromDetail,
    reqFromDetail,
    verbCategories: Array.from(verbCategories)
  };
}

/**
 * 根据岗位标题查找当前可见的卡片元素
 * 用于解决虚拟列表导致的DOM元素引用失效问题
 */
function findCardByTitle(title) {
  for (const selector of JOB_CARD_SELECTORS) {
    const cards = document.querySelectorAll(selector);
    for (const card of cards) {
      let cardTitle = '';
      for (const sel of JOB_TITLE_SELECTORS) {
        const el = card.querySelector(sel);
        if (el) { cardTitle = el.textContent.trim(); break; }
      }
      if (!cardTitle) {
        const linkEl = card.querySelector('a[href*="job"]');
        if (linkEl) cardTitle = linkEl.textContent.trim();
      }
      if (cardTitle === title) {
        return card;
      }
    }
  }
  return null;
}

/**
 * 为一个岗位补全详情信息
 */
async function enrichJobWithDetail(job) {
  try {
    // 动态查找当前可见的卡片元素（避免虚拟列表引用失效）
    const card = findCardByTitle(job.title);

    if (!card) {
      // 卡片已不在当前视口，使用标签分类兜底
      job.requirements = [...new Set([...job.requirements, ...job.tagCategories])];
      job.hasDetail = false;
      return job;
    }

    const detail = await extractDetailForCard(card);

    if (detail) {
      // 合并职责：标签+详情
      const allResp = new Set([...job.responsibilities, ...detail.respFromDetail]);

      // 合并要求：标签分类 + 详情匹配 + 动词模式
      const allReq = new Set([
        ...job.tagCategories,
        ...detail.reqFromDetail,
        ...detail.verbCategories
      ]);

      job.responsibilities = Array.from(allResp);
      job.requirements = Array.from(allReq);
      job.hasDetail = true;
    } else {
      // 详情面板不可用（可能是导航跳走了），用标签分类兜底
      job.requirements = [...new Set([...job.requirements, ...job.tagCategories])];
      job.hasDetail = false;
    }
  } catch (e) {
    console.warn('[Boss分析器] 详情提取失败:', e);
    job.requirements = [...new Set([...job.requirements, ...job.tagCategories])];
    job.hasDetail = false;
  }

  return job;
}

// ==================== 主流程：滚动 + 详情提取 ====================

/**
 * 完整提取流程：先滚动收集岗位 → 再逐个提取详情
 */
async function fullExtraction() {
  if (autoScrolling) return [];
  autoScrolling = true;

  const allJobs = [];
  const seenTitles = new Set();

  console.log(`[Boss分析器] 开始完整提取流程，目标: ${TARGET_JOB_COUNT}个`);

  // 先等待页面加载
  if (document.readyState !== 'complete') {
    console.log('[Boss分析器] 等待页面加载...');
    await new Promise(r => setTimeout(r, 2000));
  }

  // 额外等待动态渲染
  await new Promise(r => setTimeout(r, 1000));

  // === 阶段1: 滚动加载尽可能多的岗位卡片（目标30个）===
  let scrollAttempts = 0;
  let staleCount = 0;

  while (scrollAttempts < MAX_SCROLL_ATTEMPTS) {
    scrollAttempts++;

    // 使用新的检测引擎查找卡片
    const cards = findAllJobCards();

    // 从卡片中提取岗位信息
    for (const card of cards) {
      const job = extractJobFromCard(card);
      if (job && !seenTitles.has(job.title)) {
        seenTitles.add(job.title);
        allJobs.push(job);
      }
    }

    // 打印诊断信息
    if (scrollAttempts === 1 || scrollAttempts % 5 === 0) {
      console.log(`[Boss分析器] 第${scrollAttempts}轮：卡片${cards.length}个，岗位${allJobs.length}个`);
    }

    // 达到目标数量，停止滚动
    if (allJobs.length >= TARGET_JOB_COUNT) {
      console.log(`[Boss分析器] 已达到目标 ${allJobs.length} 个，停止滚动`);
      break;
    }

    // 检测到底部
    const beforeScroll = allJobs.length;
    window.scrollTo({
      top: document.body.scrollHeight,
      behavior: 'smooth'
    });
    await new Promise(r => setTimeout(r, SCROLL_DELAY));

    // 滚动后再检查一次
    const newCards = findAllJobCards();
    for (const card of newCards) {
      const job = extractJobFromCard(card);
      if (job && !seenTitles.has(job.title)) {
        seenTitles.add(job.title);
        allJobs.push(job);
      }
    }

    const newThisRound = allJobs.length - beforeScroll;

    if (newThisRound === 0) {
      staleCount++;
      if (staleCount >= MAX_STALE_ATTEMPTS) {
        console.log(`[Boss分析器] 连续${staleCount}次无新增，已到达底部`);
        break;
      }
      // 尝试小滚动触发懒加载
      window.scrollBy({ top: 200, behavior: 'instant' });
      await new Promise(r => setTimeout(r, 400));
    } else {
      staleCount = 0;
    }
  }

  console.log(`[Boss分析器] 阶段1完成：共提取 ${allJobs.length} 个岗位（尝试${scrollAttempts}次）`);

  if (allJobs.length === 0) {
    autoScrolling = false;

    // 输出诊断信息
    const pageInfo = collectPageDiagnostic();
    console.warn('[Boss分析器] 未检测到岗位！诊断信息：', pageInfo);

    // 返回诊断信息给调用方
    return {
      jobs: [],
      diagnostic: pageInfo
    };
  }

  // === 阶段2: 逐个提取详情 ===
  const detailCount = Math.min(allJobs.length, MAX_DETAIL_EXTRACT);
  const jobsToDetail = allJobs.slice(0, detailCount);

  console.log(`[Boss分析器] 阶段2开始：为 ${detailCount} 个岗位提取详情...`);

  for (let i = 0; i < jobsToDetail.length; i++) {
    const job = jobsToDetail[i];
    await enrichJobWithDetail(job);

    if ((i + 1) % 5 === 0 || i === jobsToDetail.length - 1) {
      console.log(`[Boss分析器] 详情进度: ${i + 1}/${jobsToDetail.length}`);
    }
  }

  // === 阶段3: 兜底 ===
  for (let i = detailCount; i < allJobs.length; i++) {
    const job = allJobs[i];
    job.requirements = [...new Set([...job.requirements, ...job.tagCategories])];
  }

  const withReq = allJobs.filter(j => j.requirements.length > 0).length;
  const withResp = allJobs.filter(j => j.responsibilities.length > 0).length;
  const withDetail = allJobs.filter(j => j.hasDetail).length;
  console.log(`[Boss分析器] 完整提取完成：${allJobs.length} 个岗位`);
  console.log(`  - 有详情面板: ${withDetail}`);
  console.log(`  - 有能力数据: ${withReq}`);
  console.log(`  - 有职责数据: ${withResp}`);

  autoScrolling = false;
  return { jobs: allJobs };
}

/**
 * 收集页面诊断信息（用于调试）
 */
function collectPageDiagnostic() {
  const pageInfo = {
    url: window.location.href,
    readyState: document.readyState,
    bodyHeight: document.body.scrollHeight,
    scrollY: window.scrollY,
    viewportHeight: window.innerHeight,
    totalElements: document.querySelectorAll('*').length,
    divCount: document.querySelectorAll('div').length,
    liCount: document.querySelectorAll('li').length,
    jobRelatedClasses: [],
    sampleText: '',
    sampleClasses: []
  };

  // 搜索可能包含"job"的类名
  const classSet = new Set();
  const allElements = document.querySelectorAll('[class]');
  allElements.forEach(el => {
    const cls = el.className;
    if (typeof cls === 'string') {
      cls.split(/\s+/).forEach(c => {
        if (/job|card|list|result|search/i.test(c)) {
          classSet.add(c);
        }
      });
    }
  });
  pageInfo.jobRelatedClasses = Array.from(classSet).slice(0, 30);

  // 采样页面文本
  const mainContent = document.querySelector('#main') ||
                      document.querySelector('.search-job-result') ||
                      document.querySelector('.job-list-container') ||
                      document.querySelector('main') ||
                      document.body;
  if (mainContent) {
    pageInfo.sampleText = mainContent.textContent.substring(0, 500);
  }

  // 采样一些class名
  const sampleClassSet = new Set();
  const sampleEls = document.querySelectorAll('div[class]');
  for (let i = 0; i < Math.min(50, sampleEls.length); i++) {
    const cls = sampleEls[i].className;
    if (typeof cls === 'string' && cls.length < 50) {
      sampleClassSet.add(cls);
    }
  }
  pageInfo.sampleClasses = Array.from(sampleClassSet).slice(0, 15);

  return pageInfo;
}

// ==================== 存储与消息 ====================

function saveJobsToStorage(newJobs, isNewAnalysis = false) {
  return new Promise((resolve) => {
    chrome.storage.local.get(['analysisData', 'currentJobType'], (result) => {
      let analysisData = result.analysisData || { jobs: [], totalPages: 0, lastUpdate: null };
      const currentType = getCurrentJobType();
      const previousType = result.currentJobType || '';

      if (isNewAnalysis || (previousType && previousType !== currentType)) {
        console.log('[Boss分析器] 职位类型已切换，清空旧数据');
        analysisData = { jobs: [], totalPages: 0, lastUpdate: null };
      }

      const existingKeys = new Set(
        analysisData.jobs.map(j => `${j.title}_${j.url}`)
      );

      const newJobsFiltered = newJobs.filter(job =>
        !existingKeys.has(`${job.title}_${job.url}`)
      );

      analysisData.jobs = [...analysisData.jobs, ...newJobsFiltered];
      analysisData.totalPages += 1;
      analysisData.lastUpdate = new Date().toISOString();

      chrome.storage.local.set({
        analysisData,
        currentJobType: currentType
      }, () => {
        console.log(`[Boss分析器] 数据已保存，总岗位数: ${analysisData.jobs.length}`);
        resolve(analysisData);
      });
    });
  });
}

function setupMessageListener() {
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    switch (request.action) {
      case 'ping':
        sendResponse({
          ready: true,
          isJobListPage: isJobListPage(),
          url: window.location.href
        });
        return false;

      case 'extractNow':
        handleExtractNow(sendResponse);
        return true;

      case 'getStatus':
        sendResponse({
          isJobListPage: isJobListPage(),
          url: window.location.href,
          jobType: getCurrentJobType()
        });
        return false;

      case 'clearData':
        chrome.storage.local.set({
          analysisData: { jobs: [], totalPages: 0, lastUpdate: null },
          currentJobType: ''
        }, () => {
          lastJobType = '';
          sendResponse({ success: true });
        });
        return true;

      default:
        sendResponse({ success: false, message: '未知操作' });
        return false;
    }
  });
}

async function handleExtractNow(sendResponse) {
  const startTime = Date.now();

  try {
    if (!isJobListPage()) {
      sendResponse({
        success: false,
        message: '当前不是 Boss 直聘岗位列表页，请在岗位搜索结果页使用',
        elapsed: Date.now() - startTime
      });
      return;
    }

    const result = await fullExtraction();
    const allJobs = result.jobs;

    if (allJobs.length > 0) {
      const data = await saveJobsToStorage(allJobs, true);

      const withRequirements = allJobs.filter(j => j.requirements.length > 0).length;
      const withResponsibilities = allJobs.filter(j => j.responsibilities.length > 0).length;

      sendResponse({
        success: true,
        jobsCount: allJobs.length,
        totalJobs: data.jobs.length,
        withRequirements,
        withResponsibilities,
        elapsed: Date.now() - startTime
      });
    } else {
      const diag = result.diagnostic || {};
      sendResponse({
        success: false,
        message: `未检测到岗位。可能原因：页面未加载完成、需要登录、或页面结构已变化。${diag.liCount ? `(页面有${diag.liCount}个li元素)` : ''}`,
        diagnostic: diag,
        elapsed: Date.now() - startTime
      });
    }
  } catch (error) {
    console.error('[Boss分析器] 提取异常:', error);
    sendResponse({
      success: false,
      message: '提取出错: ' + (error.message || '未知错误'),
      elapsed: Date.now() - startTime
    });
  }
}

// ==================== 页面监听 ====================

function observePageChanges() {
  setInterval(() => {
    const currentType = getCurrentJobType();
    if (currentType !== lastJobType) {
      console.log('[Boss分析器] 检测到职位类型变化，清空数据');
      lastJobType = currentType;
      chrome.storage.local.set({
        analysisData: { jobs: [], totalPages: 0, lastUpdate: null },
        currentJobType: currentType
      });
    }
  }, 1000);
}

// ==================== 启动 ====================

setupMessageListener();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    observePageChanges();
  });
} else {
  observePageChanges();
}

console.log('[Boss分析器] Content Script v5.0 已加载');
