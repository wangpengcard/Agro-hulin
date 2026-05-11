#!/usr/bin/env node
/**
 * AgroMonitoring Data Fetcher
 *
 * 免费计划可采集的全部数据 (7个端点)：
 * 1. 多边形信息
 * 2. 当前天气
 * 3. 5天天气预报 (每3小时)
 * 4. 当前土壤数据 (表面温度/10cm温度/湿度) + 历史累积
 * 5. 当前UV指数
 * 6. UV预报
 * 7. 卫星影像搜索 (最近30天, 含所有指数URL)
 * 8. NDVI历史 (最近30天)       ← 需付费计划, 已注释
 * 9. 累积温度 (最近30天)        ← 需付费计划, 已注释
 * 10. 累积降水 (最近30天)       ← 需付费计划, 已注释
 *
 * 调用预算: ~7次/运行, 每2小时1次 = ~84次/天 (限额500次/天)
 */

const fs = require('fs');
const path = require('path');

const API_KEY = process.env.AGRO_API_KEY;
const POLYGON_ID = process.env.POLYGON_ID;
const CENTER_LAT = parseFloat(process.env.POLYGON_CENTER_LAT);
const CENTER_LON = parseFloat(process.env.POLYGON_CENTER_LON);

const BASE = 'https://api.agromonitoring.com/agro/1.0';
const DATA_DIR = path.join(__dirname, '..', 'data');

// 历史数据保留天数
const HISTORY_DAYS = 30;

// ---------- 校验环境变量 ----------
const missing = [];
if (!API_KEY) missing.push('AGRO_API_KEY');
if (!POLYGON_ID) missing.push('POLYGON_ID');
if (isNaN(CENTER_LAT)) missing.push('POLYGON_CENTER_LAT');
if (isNaN(CENTER_LON)) missing.push('POLYGON_CENTER_LON');
if (missing.length) {
  console.error(`❌ 缺少环境变量: ${missing.join(', ')}`);
  process.exit(1);
}

// ---------- 工具函数 ----------
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

async function api(path) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${BASE}${path}${sep}appid=${API_KEY}`;
  const safeUrl = url.replace(API_KEY, '***');
  process.stdout.write(`  📡 ${safeUrl} ... `);
  const resp = await fetch(url);
  if (!resp.ok) {
    const body = await resp.text();
    console.log(`❌ ${resp.status}`);
    throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
  const json = await resp.json();
  console.log(`✅`);
  return json;
}

function save(name, data) {
  const fp = path.join(DATA_DIR, name);
  fs.writeFileSync(fp, JSON.stringify(data, null, 2));
  const kb = (Buffer.byteLength(JSON.stringify(data)) / 1024).toFixed(1);
  console.log(`  💾 ${name} (${kb} KB)`);
}

function now() { return Math.floor(Date.now() / 1000); }
function ago(days) { return now() - days * 86400; }

/**
 * 追加土壤数据到历史文件
 * 保留最近 HISTORY_DAYS 天的数据，按时间戳去重
 */
function appendSoilHistory(soilData) {
  const historyFile = path.join(DATA_DIR, 'soil_history.json');
  let history = [];

  // 读取已有历史
  if (fs.existsSync(historyFile)) {
    try {
      history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
      if (!Array.isArray(history)) history = [];
    } catch (e) {
      console.log(`  ⚠️ soil_history.json 解析失败，将重建`);
      history = [];
    }
  }

  // 添加新数据点
  if (soilData && soilData.dt) {
    // 检查是否已存在相同时间戳
    const exists = history.some(h => h.dt === soilData.dt);
    if (!exists) {
      history.push({
        dt: soilData.dt,
        t0: soilData.t0,
        t10: soilData.t10,
        moisture: soilData.moisture
      });
      console.log(`  ➕ 追加土壤数据点 (${new Date(soilData.dt * 1000).toISOString()})`);
    } else {
      console.log(`  ⏭️  土壤数据点已存在，跳过`);
    }
  }

  // 按时间排序
  history.sort((a, b) => a.dt - b.dt);

  // 修剪：只保留最近 HISTORY_DAYS 天
  const cutoff = ago(HISTORY_DAYS);
  const before = history.length;
  history = history.filter(h => h.dt >= cutoff);
  if (before !== history.length) {
    console.log(`  ✂️  修剪历史: ${before} → ${history.length} 条 (保留${HISTORY_DAYS}天)`);
  }

  save('soil_history.json', history);
  console.log(`  📊 土壤历史共 ${history.length} 个数据点`);
}

// ---------- 主流程 ----------
async function main() {
  const errors = [];
  let ok = 0;

  console.log(`🌾 AgroMonitoring Fetcher`);
  console.log(`   Polygon: ${POLYGON_ID}`);
  console.log(`   Center:  ${CENTER_LAT}, ${CENTER_LON}`);
  console.log(`   Time:    ${new Date().toISOString()}`);
  console.log('');

  // 1. 多边形信息
  try {
    console.log('1/7 多边形信息');
    save('polygon.json', await api(`/polygons/${POLYGON_ID}`));
    ok++;
  } catch (e) { errors.push(['polygon', e.message]); }

  // 2. 当前天气
  try {
    console.log('2/7 当前天气');
    save('weather.json', await api(`/weather?lat=${CENTER_LAT}&lon=${CENTER_LON}`));
    ok++;
  } catch (e) { errors.push(['weather', e.message]); }

  // 3. 5天预报
  try {
    console.log('3/7 5天预报');
    save('forecast.json', await api(`/weather/forecast?lat=${CENTER_LAT}&lon=${CENTER_LON}`));
    ok++;
  } catch (e) { errors.push(['forecast', e.message]); }

  // 4. 土壤（当前 + 历史累积）
  try {
    console.log('4/7 土壤数据');
    const soil = await api(`/soil?polyid=${POLYGON_ID}`);
    save('soil.json', soil);           // 保持原有单点文件兼容
    appendSoilHistory(soil);           // 追加到历史记录
    ok++;
  } catch (e) { errors.push(['soil', e.message]); }

  // 5. 当前UV
  try {
    console.log('5/7 UV指数');
    save('uvi.json', await api(`/uvi?polyid=${POLYGON_ID}`));
    ok++;
  } catch (e) { errors.push(['uvi', e.message]); }

  // 6. UV预报
  try {
    console.log('6/7 UV预报');
    save('uvi_forecast.json', await api(`/uvi/forecast?polyid=${POLYGON_ID}`));
    ok++;
  } catch (e) { errors.push(['uvi_forecast', e.message]); }

  // 7. 卫星影像搜索 (最近30天)
  try {
    console.log('7/7 卫星影像');
    const images = await api(`/image/search?start=${ago(30)}&end=${now()}&polyid=${POLYGON_ID}`);
    save('satellite.json', images);
    console.log(`     → ${Array.isArray(images) ? images.length : 0} 景影像`);
    ok++;
  } catch (e) { errors.push(['satellite', e.message]); }

  // 8. NDVI历史 — 需付费计划 (Free plan 不支持历史数据)
  // try {
  //   console.log('8/7 NDVI历史');
  //   const ndvi = await api(`/ndvi/history?start=${ago(30)}&end=${now()}&polyid=${POLYGON_ID}`);
  //   save('ndvi.json', ndvi);
  //   console.log(`     → ${Array.isArray(ndvi) ? ndvi.length : 0} 条记录`);
  //   ok++;
  // } catch (e) { errors.push(['ndvi', e.message]); }

  // 9. 累积温度 — 需付费计划 (Free plan 不支持历史数据)
  // try {
  //   console.log('9/7 累积温度');
  //   save('acc_temp.json', await api(`/weather/history/accumulated_temperature?lat=${CENTER_LAT}&lon=${CENTER_LON}&start=${ago(30)}&end=${now()}`));
  //   ok++;
  // } catch (e) { errors.push(['acc_temp', e.message]); }

  // 10. 累积降水 — 需付费计划 (Free plan 不支持历史数据)
  // try {
  //   console.log('10/7 累积降水');
  //   save('acc_precip.json', await api(`/weather/history/accumulated_precipitation?lat=${CENTER_LAT}&lon=${CENTER_LON}&start=${ago(30)}&end=${now()}`));
  //   ok++;
  // } catch (e) { errors.push(['acc_precip', e.message]); }

  // 元数据
  save('meta.json', {
    updated: new Date().toISOString(),
    polygon_id: POLYGON_ID,
    center: { lat: CENTER_LAT, lon: CENTER_LON },
    ok,
    errors: errors.map(([k, v]) => ({ endpoint: k, error: v }))
  });

  // 汇总
  console.log('');
  console.log(`✅ 完成: ${ok}/7 成功`);
  if (errors.length) {
    console.log(`⚠️  失败 ${errors.length} 个:`);
    errors.forEach(([k, v]) => console.log(`   ${k}: ${v}`));
  }
}

main().catch(e => {
  console.error('💥 致命错误:', e.message);
  process.exit(1);
});
