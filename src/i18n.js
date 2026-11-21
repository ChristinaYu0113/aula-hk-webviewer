export const copy = {
  en: {
    title: '3D Building Viewer', language: 'Language', scene: 'Scene', modes: 'Model mode',
    monument: 'Monument', aula: 'AULA · TU Delft', viewport: '3D viewport',
    canvas: 'Drag to orbit, scroll to zoom, or click to select a patch',
    colors: 'Patch coloring', original: 'Original', patch: 'Segmentation colors',
    materialColor: 'By material', structureColor: 'By structure',
    linkedColors: 'Linked colors', linkedComponents: 'Linked components', linkedViews: 'Linked views',
    reset: 'Reset view', retry: 'Try again', progress: 'Model loading progress',
    patches: 'Patches', patchCount: 'Patch count', patchList: 'Patch list',
    selected: 'Selected patch', filter: 'Filter patches', filterHint: 'Search by name or ID',
    clear: 'Clear selection', isolate: 'Show only this patch', isolateComponent: 'Show only this component',
    showAll: 'Show all patches',
    patchId: 'Patch ID', material: 'Material', structure: 'Structure', decoration: 'Decoration',
    spcClass: 'SPC classification', scanPatch: 'Scan Patch', pendingMatch: 'Pending match',
    isolatePatches: 'Show only matched patches',
    unclassified: 'Unclassified', noMatches: 'No matching patches',
    drag: 'Drag', orbit: 'orbit', scroll: 'Scroll', zoom: 'zoom', click: 'Click', select: 'select a patch',
    spc: 'Color point cloud', hdim: 'Building information model (HBIM)', s3dgs: 'Segmented Gaussian splats',
    points: 'points', triangles: 'triangles', splats: 'Gaussian splats',
    loading: 'Loading', loadFailed: 'Could not load the model. Try again.',
    webglFailed: 'Unable to start WebGL 2. Check the browser’s hardware acceleration.',
    contextLost: 'The graphics context was lost. Reload the viewer to continue.',
    unavailable: 'This scan includes patch IDs only.',
    sourceCount: count => `Original dataset contains ${count} elements. The viewer shows a sampled preview.`,
  },
  'zh-CN': {
    title: '建筑三维查看器', language: '界面语言', scene: '场景', modes: '模型模式',
    monument: 'Monument · 纪念碑', aula: 'AULA · 代尔夫特理工大学', viewport: '三维视图',
    canvas: '拖拽旋转，滚轮缩放，单击选择分块',
    colors: '分块着色', original: '原色', patch: '分割颜色', materialColor: '按材质', structureColor: '按结构',
    linkedColors: '联动颜色', linkedComponents: '联动构件', linkedViews: '联动视图',
    reset: '复位', retry: '重新加载', progress: '模型加载进度',
    patches: '分块', patchCount: '分块数', patchList: '分块列表',
    selected: '选中的分块', filter: '查找分块', filterHint: '查找编号或名称',
    clear: '清除选择', isolate: '仅显示此分块', isolateComponent: '仅显示此构件', showAll: '显示全部分块',
    patchId: '分块号', material: '材质', structure: '结构', decoration: '装饰',
    spcClass: 'SPC 分类', scanPatch: 'Scan Patch', pendingMatch: '待匹配',
    isolatePatches: '仅显示匹配分块',
    unclassified: '未分类', noMatches: '没有匹配的分块',
    drag: '拖拽', orbit: '旋转', scroll: '滚轮', zoom: '缩放', click: '单击', select: '选择分块',
    spc: '彩色点云', hdim: '建筑信息模型（HBIM）', s3dgs: '分块高斯泼溅',
    points: '个点', triangles: '个三角形', splats: '个高斯',
    loading: '正在加载', loadFailed: '模型加载失败，请重新加载。',
    webglFailed: '无法初始化 WebGL 2，请检查浏览器的硬件加速。',
    contextLost: '图形上下文已断开，请重新加载。',
    unavailable: '此扫描数据只提供分块编号。',
    sourceCount: count => `原始数据共有 ${count} 个元素，网页显示采样预览。`,
  },
};

export function translatePage(locale) {
  const strings = copy[locale];
  document.documentElement.lang = locale;
  document.title = strings.title;
  for (const node of document.querySelectorAll('[data-copy]')) {
    node.textContent = strings[node.dataset.copy];
  }
  for (const [binding, attribute] of [['aria', 'aria-label'], ['title', 'title'], ['placeholder', 'placeholder']]) {
    for (const node of document.querySelectorAll(`[data-copy-${binding}]`)) {
      node.setAttribute(attribute, strings[node.getAttribute(`data-copy-${binding}`)]);
    }
  }
}
