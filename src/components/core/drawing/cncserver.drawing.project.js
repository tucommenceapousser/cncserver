/**
 * @file Code for drawing project breakdown management.
 */
const { Path, Rectangle } = require('paper');

module.exports = (cncserver, drawing) => {
  function getPaths(parent, items = []) {
    if (parent.children && parent.children.length) {
      let moreItems = [];
      parent.children.forEach((child) => {
        moreItems = getPaths(child, moreItems);
      });
      return [...items, ...moreItems];
    }

    return [...items, parent];
  }


  const project = (svgData, hash, bounds = null) => {
    const { base: { project: pp } } = drawing;
    // TODO: fail project on API when it doesn't import correctly.
    const item = pp.importSVG(svgData.trim(), {
      expandShapes: true,
      applyMatrix: true,
    });

    // TODO: figure out good way to default fit bounds.
    if (!bounds) {
      const margin = 20; // 2cm margin
      item.fitBounds({
        from: [margin, margin],
        to: [drawing.base.size.width - margin, drawing.base.size.height - margin],
      });
    } else {
      item.fitBounds(bounds);
    }

    const allPaths = getPaths(item);
    // console.log('How many?', allPaths.length); return;

    // Move through all paths and add each one as a job.
    allPaths.forEach((path) => {
      // Only add non-zero length path tracing jobs.
      if (path.length) {
        cncserver.jobs.addItem({
          operation: 'trace',
          type: 'job',
          parent: hash,
          body: path,
        });
      }
    });
  };

  return project;
};