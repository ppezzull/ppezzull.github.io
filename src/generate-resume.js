const fs = require('fs');
const path = require('path');

const cheerio = require('cheerio');

function setupBabel() {
  try {
    require('@babel/register')({
      presets: [
        ['@babel/preset-env', { targets: { node: 'current' }, modules: 'commonjs' }],
        ['@babel/preset-react', { runtime: 'automatic' }]
      ],
      extensions: ['.js', '.jsx'],
      ignore: [
        function (filepath) {
          if (filepath.includes('node_modules/jsonresume-theme-professional')) return false;
          return /node_modules/.test(filepath);
        }
      ]
    });
    // Ensure peer deps are resolvable
    require('react');
    require('react-dom/server');
    require('styled-components');
  } catch (e) {
    const hint = [
      'Missing build deps. Please install devDependencies before generating.',
      '- Run: npm install',
      '- If NODE_ENV=production or npm config production=true, dev deps are skipped. Use: npm install --include=dev',
    ].join('\n');
    throw new Error(e.message + '\n' + hint);
  }
}

function loadResumeData(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
}

// Projects render in array order; keep them reverse-chronological (newest
// startDate first) regardless of how the JSON is edited. ISO dates sort
// lexicographically.
function sortProjectsByStartDateDesc(projects) {
  if (!Array.isArray(projects)) return projects;
  return [...projects].sort((a, b) =>
    (b.startDate || '').localeCompare(a.startDate || '')
  );
}

function getThemeRender() {
  const theme = require('jsonresume-theme-professional');
  const render = theme.render || (theme.default && theme.default.render);
  if (typeof render !== 'function') {
    throw new Error('jsonresume-theme-professional did not export a render() function.');
  }
  return render;
}

function mapMissingFonts(html) {
  return html.replace(/lmsans10-(regular|bold|italic)\.otf/g, (_m, s) => `lmroman10-${s}.otf`);
}

function rewriteFontUrls(html) {
  const urlFontsRegex = /url\((['"])??(?:\.\.\/|\.\/|\/)?fonts\/(?:[^/'")]\/)*([^/'")]+\.otf)\1?\)/g;
  return html.replace(urlFontsRegex, (_match, _quote, file) => `url("../fonts/${file}")`);
}

function injectBaseFontSize(html, sizePx) {
  const tag = `<style>html{font-size:${sizePx}}</style>`;
  return html.replace('</head>', `${tag}</head>`);
}

// The theme's DateRange hardcodes an em dash ("&nbsp;—&nbsp;") between dates.
// Swap it for an en dash so no em dashes appear anywhere in the output.
function replaceDateRangeDashes(html) {
  return html.replace(/&nbsp;—&nbsp;/g, '&nbsp;–&nbsp;');
}

// The theme hardcodes section order (Education before Work/Projects) in its
// Resume component; reordering here survives node_modules reinstalls.
// Sections are a plain wrapper <div> around a styled <div><h2>Title</h2>…,
// so locate them by heading text rather than styled-components class names.
function moveSectionAfter(html, sectionTitle, afterTitle) {
  const $ = cheerio.load(html);
  const findWrapper = (title) =>
    $('h2')
      .filter(function () { return $(this).text().trim() === title; })
      .closest('div')
      .parent();
  const moving = findWrapper(sectionTitle);
  const anchor = findWrapper(afterTitle);
  if (moving.length && anchor.length) {
    moving.insertAfter(anchor);
  }
  return $.html();
}

function injectLinks(html, resume) {
  // Use cheerio to parse and manipulate HTML
  const $ = cheerio.load(html);

  // Common selectors observed in the theme output (keeps it DRY)
  // include additional selectors observed in rendered HTML (references use sc-kCuUfV / sc-dNdcvo)
  const titleSelectors = [
    'div.sc-hjsuWn.jINFql',
    'div.sc-jJLAfE.jsgwBQ',
    'div.sc-kCuUfV.bEuQPz',
    'p.sc-dNdcvo'
  ];

  // Normalizes text for comparison: collapse whitespace and lower-case
  function normalizeText(s) {
    return (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  // Safely create and append an <a> to the element
  function wrapElementWithLink(el, href, linkText) {
    if (el.find('a').length > 0) return; // already linked
    const a = $('<a>')
      .attr('href', href)
      .attr('target', '_blank')
      .attr('rel', 'noopener noreferrer')
      .css('color', 'inherit')
      .css('text-decoration', 'none')
      .text(linkText);
    // External-link marker: injected links inherit color and have no
    // underline, so without it they are visually undetectable
    a.append(
      $('<span>')
        .text('↗')
        .css({ 'font-size': '0.8em', 'margin-left': '2px' })
    );
    el.empty().append(a);
  }

  // Generic helper: iterate entries, look for matching rendered nodes, and wrap
  function linkifyEntries(entries, fieldName) {
    if (!Array.isArray(entries)) return;
    entries.forEach(entry => {
      const href = entry.website;
      const raw = entry[fieldName];
      if (!href || !raw) return;
      const targetNorm = normalizeText(raw);
      // Try exact match first, fall back to contains match
      $(titleSelectors.join(',')).each(function () {
        const el = $(this);
        const rendered = normalizeText(el.text());
        if (!rendered) return;
        if (rendered === targetNorm || rendered.includes(targetNorm)) {
          wrapElementWithLink(el, href, raw);
        }
      });
    });
  }

  // Map resume sections to the field that should be linked
  // work -> position AND name, projects -> name, education -> institution
  linkifyEntries(resume.work, 'position');
  linkifyEntries(resume.work, 'name');
  linkifyEntries(resume.projects, 'name');
  linkifyEntries(resume.education, 'institution');
  linkifyEntries(resume.awards, 'title');

  // Support alternate certificate fields: certificates or certifications
  // Some resume files use `title`, others use `name` for certificate entries — try both.
  if (Array.isArray(resume.certificates)) {
    linkifyEntries(resume.certificates, 'title');
    linkifyEntries(resume.certificates, 'name');
  }
  if (Array.isArray(resume.certifications)) {
    linkifyEntries(resume.certifications, 'title');
    linkifyEntries(resume.certifications, 'name');
  }

  // Link references (try both 'name' and 'reference' fields)
  if (Array.isArray(resume.references)) {
    linkifyEntries(resume.references, 'name');
  }

  return $.html();
}

function writeHtml(outPath, html) {
  fs.writeFileSync(path.resolve(outPath), html);
}

function main() {
  try {
    setupBabel();
    const render = getThemeRender();
    const resume = loadResumeData('./src/resume.json');
    resume.projects = sortProjectsByStartDateDesc(resume.projects);

  let html = render(resume);
  html = mapMissingFonts(html);
  html = rewriteFontUrls(html);
  html = injectBaseFontSize(html, '11.5px');
  html = injectLinks(html, resume);
  html = replaceDateRangeDashes(html);
  html = moveSectionAfter(html, 'Education', 'Projects');
  writeHtml('./src/resume.html', html);

    console.log('Resume successfully generated: src/resume.html');
  } catch (error) {
    console.error('Failed to generate resume:', error);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}