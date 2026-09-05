/** 牌阵定义：按张数返回可选 spread，含位置标签 */

export const SPREADS = {
  single: {
    id: 'single',
    count: 1,
    name: '单张凝视',
    tag: '基础中的基础',
    desc: '抽一张，慢慢看。不急着解释，先只是凝视。',
    layout: 'single',
    positions: [{ key: 'gaze', label: '凝视', hint: '此刻映出什么' }],
  },
  timeline3: {
    id: 'timeline3',
    count: 3,
    name: '时间轴',
    tag: '适合迷茫／转折',
    desc: '来处 · 今处 · 往处。看见自己走在时间线上的位置。',
    layout: 'row',
    positions: [
      { key: 'past', label: '来处', hint: '从哪里来' },
      { key: 'present', label: '今处', hint: '现在站在哪' },
      { key: 'future', label: '往处', hint: '往哪里去' },
    ],
  },
  triangle3: {
    id: 'triangle3',
    count: 3,
    name: '镜像三角',
    tag: '可选 · Stub',
    desc: '看见 · 感受 · 行动。三角互映，照见完整一角。',
    layout: 'triangle',
    positions: [
      { key: 'see', label: '看见', hint: '你看见什么' },
      { key: 'feel', label: '感受', hint: '身体与情绪' },
      { key: 'act', label: '行动', hint: '下一步微行动' },
    ],
  },
  cross5: {
    id: 'cross5',
    count: 5,
    name: '十字简阵',
    tag: '中心＋四向',
    desc: '中心是此刻，四方是镜像里的拉力与资源。',
    layout: 'cross',
    positions: [
      { key: 'north', label: '上方', hint: '被吸引／向往' },
      { key: 'west', label: '左方', hint: '过去／放下' },
      { key: 'center', label: '中心', hint: '此刻的核心' },
      { key: 'east', label: '右方', hint: '未来／靠近' },
      { key: 'south', label: '下方', hint: '根基／支撑' },
    ],
  },
  grid9: {
    id: 'grid9',
    count: 9,
    name: '九宫格',
    tag: '全景镜像',
    desc: '九格如镜阵，从角落到中心，慢慢扫过自己。',
    layout: 'grid3',
    positions: [
      { key: 'nw', label: '左上', hint: '远景／愿景' },
      { key: 'n', label: '上中', hint: '心之所向' },
      { key: 'ne', label: '右上', hint: '可能的出口' },
      { key: 'w', label: '左中', hint: '内在资源' },
      { key: 'c', label: '正中', hint: '当下自我' },
      { key: 'e', label: '右中', hint: '外在关系' },
      { key: 'sw', label: '左下', hint: '阴影／盲区' },
      { key: 's', label: '下中', hint: '身体／根基' },
      { key: 'se', label: '右下', hint: '落地行动' },
    ],
  },
  fan: {
    id: 'fan',
    count: 0, // dynamic
    name: '扇形展开',
    tag: '任意张数',
    desc: '以扇形铺开，适合少量到中等张数的直觉浏览。',
    layout: 'fan',
    positions: [], // filled dynamically
  },
  gridAuto: {
    id: 'gridAuto',
    count: 0,
    name: '网格铺陈',
    tag: '任意张数',
    desc: '自动网格排列，适合较多张数的整体观照。',
    layout: 'gridAuto',
    positions: [],
  },
};

/** 根据张数返回可选牌阵列表 */
export function spreadsForCount(n) {
  n = Number(n);
  if (n === 1) return [SPREADS.single];
  if (n === 3) return [SPREADS.timeline3, SPREADS.triangle3];
  if (n === 5) return [SPREADS.cross5];
  if (n === 9) return [SPREADS.grid9];
  // arbitrary
  const list = [];
  if (n <= 12) list.push({ ...SPREADS.fan, count: n });
  list.push({ ...SPREADS.gridAuto, count: n });
  return list;
}

/** 默认牌阵：取 spreadsForCount(n) 的第一项 */
export function defaultSpreadForCount(n) {
  const list = spreadsForCount(n);
  return list[0] || null;
}

/** 为任意 spread 生成带序号的位置（扇形／网格） */
export function resolvePositions(spread, count) {
  if (spread.positions && spread.positions.length === count) {
    return spread.positions.map((p) => ({ ...p }));
  }
  return Array.from({ length: count }, (_, i) => ({
    key: `p${i + 1}`,
    label: `第 ${i + 1} 位`,
    hint: `镜像位 ${i + 1}`,
  }));
}

export const MODE_OPTIONS = [
  { id: '1', count: 1, label: '单张', sub: '凝视一张' },
  { id: '3', count: 3, label: '三张', sub: '时间／三角' },
  { id: '5', count: 5, label: '五张', sub: '十字简阵' },
  { id: '9', count: 9, label: '九张', sub: '九宫全景' },
  { id: 'custom', count: null, label: '自定义', sub: '输入 1–69' },
];

/** 引导提问层（详情 sheet） */
export const REFLECTION_LAYERS = [
  { id: 'see', title: '看见什么', q: '第一眼抓住你的是什么？哪里让你停了一下？' },
  { id: 'body', title: '身体感受', q: '说到这儿，身体哪处有反应？呼吸、胸口、腹部……' },
  { id: 'mirror', title: '对你像什么镜子', q: '若它是一面镜子，映出你生活里的哪一部分？' },
  { id: 'speak', title: '想对它说什么', q: '你想对这张卡说一句什么？不必完整，一句就够。' },
  { id: 'take', title: '带一句走', q: '把今天看见的，收成一句今天就能带走的话。' },
];
