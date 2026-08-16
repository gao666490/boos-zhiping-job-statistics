/**
 * Boss直聘岗位任职要求共性分析 - Popup Script
 *
 * 统计维度：
 * 1. 任职能力要求统计 — 人需掌握的技能（编程语言、框架、工具等）
 * 2. 岗位职责统计 — 人在岗位上要干的事（日常工作内容）
 */

let currentAnalysisData = null;
let isAnalyzing = false;
let lastKnownJobType = '';

const els = {};

function cacheDom() {
  els.analyzeBtn = document.getElementById('analyzeBtn');
  els.clearBtn = document.getElementById('clearBtn');
  els.statusDot = document.getElementById('statusDot');
  els.statusText = document.getElementById('statusText');
  els.statsOverview = document.getElementById('statsOverview');
  els.totalJobs = document.getElementById('totalJobs');
  els.totalPages = document.getElementById('totalPages');
  els.uniqueSkills = document.getElementById('uniqueSkills');
  els.skillChartSection = document.getElementById('skillChartSection');
  els.skillChart = document.getElementById('skillChart');
  els.responsibilityChartSection = document.getElementById('responsibilityChartSection');
  els.responsibilityChart = document.getElementById('responsibilityChart');
  els.loading = document.getElementById('loading');
  els.loadingText = document.getElementById('loadingText');
  els.scrollProgress = document.getElementById('scrollProgress');
  els.scrollFill = document.getElementById('scrollFill');
  els.scrollInfo = document.getElementById('scrollInfo');
  els.emptyState = document.getElementById('emptyState');
  els.updateTime = document.getElementById('updateTime');
}

document.addEventListener('DOMContentLoaded', async () => {
  cacheDom();

  els.analyzeBtn.addEventListener('click', handleAnalyzeClick);
  els.clearBtn.addEventListener('click', handleClearClick);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.currentJobType) {
      const newType = changes.currentJobType.newValue || '';
      const oldType = changes.currentJobType.oldValue || '';
      if (oldType && newType !== oldType) {
        lastKnownJobType = newType;
        renderEmptyState();
      }
    }
    if (areaName === 'local' && changes.analysisData) {
      const newData = changes.analysisData.newValue;
      if (newData && newData.jobs && newData.jobs.length > 0) {
        currentAnalysisData = newData;
        renderAll(newData);
      } else {
        renderEmptyState();
      }
    }
  });

  await checkContentScript();
  await loadAndRenderData();
});

async function checkContentScript() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      updateStatus('error', '无法获取当前标签页');
      return;
    }
    const response = await chrome.tabs.sendMessage(tab.id, { action: 'ping' });
    if (response && response.ready) {
      if (response.isJobListPage) {
        updateStatus('ready', '已就绪 - 岗位列表页');
      } else {
        updateStatus('ready', '已就绪 - 非岗位页');
      }
    } else {
      updateStatus('error', 'Content Script 未响应');
    }
  } catch (e) {
    updateStatus('error', '无法连接到页面');
  }
}

function updateStatus(type, text) {
  els.statusDot.className = 'status-dot status-' + type;
  els.statusText.textContent = text;
}

async function loadAndRenderData() {
  chrome.storage.local.get(['analysisData', 'currentJobType'], (result) => {
    if (result.currentJobType) {
      lastKnownJobType = result.currentJobType;
    }
    if (result.analysisData && result.analysisData.jobs && result.analysisData.jobs.length > 0) {
      currentAnalysisData = result.analysisData;
      renderAll(result.analysisData);
    } else {
      renderEmptyState();
    }
  });
}

function renderEmptyState() {
  els.statsOverview.style.display = 'none';
  els.skillChartSection.style.display = 'none';
  els.responsibilityChartSection.style.display = 'none';
  els.emptyState.style.display = 'block';
  els.clearBtn.disabled = true;
  els.updateTime.textContent = '';
}

function renderAll(data) {
  if (!data || !data.jobs || data.jobs.length === 0) {
    renderEmptyState();
    return;
  }

  els.emptyState.style.display = 'none';
  els.clearBtn.disabled = false;

  els.totalJobs.textContent = data.jobs.length;
  els.totalPages.textContent = data.totalPages || 0;

  const uniqueItems = new Set();
  data.jobs.forEach(job => {
    if (job.responsibilities) job.responsibilities.forEach(s => uniqueItems.add(s));
    if (job.requirements) job.requirements.forEach(s => uniqueItems.add(s));
  });
  els.uniqueSkills.textContent = uniqueItems.size;
  els.statsOverview.style.display = 'flex';

  // 图1: 任职能力要求 → requirements (需掌握的技能)
  renderSkillChart(data.jobs);
  // 图2: 岗位职责 → responsibilities (日常工作)
  renderResponsibilityChart(data.jobs);

  if (data.lastUpdate) {
    const d = new Date(data.lastUpdate);
    els.updateTime.textContent = `更新于 ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
}

/**
 * 统计字段出现频次
 */
function countFrequencies(jobs, field) {
  const counter = {};
  jobs.forEach(job => {
    const items = job[field] || [];
    items.forEach(item => {
      counter[item] = (counter[item] || 0) + 1;
    });
  });
  return Object.entries(counter)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * 渲染通用柱状图
 */
function renderBarChart(container, data, totalJobs, colorFrom, colorTo, maxItems) {
  container.innerHTML = '';

  if (!data || data.length === 0) {
    container.innerHTML = '<div class="chart-empty">暂无数据</div>';
    return;
  }

  const displayData = data.slice(0, maxItems);
  const maxCount = displayData[0].count;

  displayData.forEach((item, index) => {
    const percentage = ((item.count / totalJobs) * 100).toFixed(0);
    const widthPercent = maxCount > 0 ? (item.count / maxCount * 100) : 0;

    const itemEl = document.createElement('div');
    itemEl.className = 'bar-item';
    itemEl.style.animationDelay = (index * 0.05) + 's';

    itemEl.innerHTML = `
      <div class="bar-label" title="${item.name}">${item.name}</div>
      <div class="bar-track">
        <div class="bar-fill" style="width: ${widthPercent}%;
          background: linear-gradient(90deg, ${colorFrom}, ${colorTo});">
        </div>
      </div>
      <div class="bar-stats">
        <span class="bar-count">${item.count}</span>
        <span class="bar-percent">${percentage}%</span>
      </div>
    `;

    container.appendChild(itemEl);
  });
}

/**
 * 任职能力要求统计 — 展示人需掌握的技能（requirements 字段）
 * 如：Java、Python、Spark、Flink、Kafka、MySQL 等
 */
function renderSkillChart(jobs) {
  const ranking = countFrequencies(jobs, 'requirements');
  renderBarChart(els.skillChart, ranking, jobs.length, '#667eea', '#764ba2', 15);
  els.skillChartSection.style.display = 'block';
}

/**
 * 岗位职责统计 — 展示人在岗位上要干的事（responsibilities 字段）
 * 如：数据仓库建设、接口开发、算法实现、架构设计等
 */
function renderResponsibilityChart(jobs) {
  const ranking = countFrequencies(jobs, 'responsibilities');
  renderBarChart(els.responsibilityChart, ranking, jobs.length, '#f97316', '#e11d48', 15);
  els.responsibilityChartSection.style.display = 'block';
}

// ==================== 事件处理 ====================

async function handleAnalyzeClick() {
  if (isAnalyzing) return;
  isAnalyzing = true;

  els.analyzeBtn.disabled = true;
  els.analyzeBtn.querySelector('.btn-text').textContent = '分析中...';
  els.loading.style.display = 'block';
  els.loadingText.textContent = '阶段1/2：滚动加载岗位卡片...';
  els.scrollProgress.style.display = 'block';
  els.scrollFill.style.width = '0%';
  els.scrollInfo.textContent = '阶段1/2 · 正在滚动收集岗位';

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      throw new Error('无法获取当前标签页');
    }

    updateStatus('loading', '正在分析...');

    const response = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('分析超时（90秒）')), 90000);

      let progress = 0;
      let phase = 1;
      const progressInterval = setInterval(() => {
        if (phase === 1) {
          progress += Math.random() * 4;
          if (progress > 45) {
            phase = 2;
            els.loadingText.textContent = '阶段2/2：逐个提取岗位详情...';
          }
        } else {
          progress += Math.random() * 2;
        }
        progress = Math.min(progress, 92);
        els.scrollFill.style.width = progress + '%';
      }, 500);

      chrome.tabs.sendMessage(tab.id, { action: 'extractNow' }, (resp) => {
        clearTimeout(timeout);
        clearInterval(progressInterval);
        if (chrome.runtime.lastError) {
          reject(new Error('无法连接到页面：' + chrome.runtime.lastError.message));
        } else {
          resolve(resp);
        }
      });
    });

    if (response && response.success) {
      els.scrollFill.style.width = '100%';
      const totalJobs = response.jobsCount;
      const reqCount = response.withRequirements || 0;
      const respCount = response.withResponsibilities || 0;

      // 完成时显示详细统计
      let infoText = `${totalJobs}个岗位`;
      if (reqCount > 0) infoText += ` · ${reqCount}个有能力数据`;
      if (respCount > 0) infoText += ` · ${respCount}个有职责数据`;
      els.scrollInfo.textContent = infoText;

      const statusText = totalJobs >= 30
        ? `分析完成 - 已收集 ${totalJobs} 个岗位`
        : `分析完成 - 共 ${totalJobs} 个岗位（页面仅有这些）`;
      updateStatus('ready', statusText);

      setTimeout(() => {
        els.loading.style.display = 'none';
        els.scrollProgress.style.display = 'none';
      }, 800);

      chrome.storage.local.get(['analysisData'], (result) => {
        if (result.analysisData && result.analysisData.jobs) {
          currentAnalysisData = result.analysisData;
          renderAll(result.analysisData);
        }
      });
    } else {
      throw new Error(response?.message || '分析失败');
    }
  } catch (error) {
    console.error('分析出错:', error);
    els.loading.style.display = 'none';
    els.scrollProgress.style.display = 'none';
    updateStatus('error', '分析失败');

    let errorMsg = error.message || '未知错误';
    if (errorMsg.includes('不是 Boss 直聘岗位列表页')) {
      errorMsg = '请在 Boss 直聘的岗位搜索列表页使用此插件';
    } else if (errorMsg.includes('无法连接')) {
      errorMsg = '页面加载中或非 zhipin.com 域名，请刷新页面后重试';
    }

    alert('❌ 分析失败\n\n' + errorMsg);
  } finally {
    isAnalyzing = false;
    els.analyzeBtn.disabled = false;
    els.analyzeBtn.querySelector('.btn-text').textContent = '立即分析当前页';
  }
}

function handleClearClick() {
  if (!confirm('确定要清除所有分析数据吗？')) return;

  chrome.storage.local.set({
    analysisData: { jobs: [], totalPages: 0, lastUpdate: null },
    currentJobType: ''
  }, () => {
    currentAnalysisData = null;
    lastKnownJobType = '';
    renderEmptyState();
    updateStatus('ready', '数据已清除');
  });
}
