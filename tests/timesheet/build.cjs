// Refresh the self-contained test HTML from the reviewable module sources.
const fs=require('fs');let html=fs.readFileSync('index-test.html','utf8');
const css=fs.readFileSync('assets/timesheet.css','utf8'),core=fs.readFileSync('assets/timesheet-core.js','utf8'),ui=fs.readFileSync('assets/timesheet.js','utf8');
const style='<!-- TIMESHEET CSS START -->\n<style id="timesheet-css">\n'+css+'\n</style>\n<!-- TIMESHEET CSS END -->';
const scripts='<!-- TIMESHEET MODULE START -->\n<script id="timesheet-core">\n'+core.replace(/<\/script/gi,'<\\/script')+'\n</script>\n<script id="timesheet-app">\n'+ui.replace(/<\/script/gi,'<\\/script')+'\n</script>\n<!-- TIMESHEET MODULE END -->';
if(html.includes('<!-- TIMESHEET CSS START -->'))html=html.replace(/<!-- TIMESHEET CSS START -->[\s\S]*?<!-- TIMESHEET CSS END -->/,()=>style);else html=html.replace('  <link rel="stylesheet" href="./assets/timesheet.css?v=3.1.0">',()=>style);
if(html.includes('<!-- TIMESHEET MODULE START -->'))html=html.replace(/<!-- TIMESHEET MODULE START -->[\s\S]*?<!-- TIMESHEET MODULE END -->/,()=>scripts);else html=html.replace('<script src="./assets/timesheet-core.js?v=3.1.0"></script>\n<script src="./assets/timesheet.js?v=3.1.0"></script>',()=>scripts);
// Clear rendered personal rows when the existing app exports a standalone HTML.
html=html.replace(/try \{ \(0, eval\)\(("(?:[^"\\]|\\.)*")\);/g,(whole,json)=>{let patch=JSON.parse(json);if(!patch.includes('function resetDomClone(')||patch.includes("'#tab-timesheet'"))return whole;patch=patch.replace("'#trucksLineList',", "'#tab-timesheet', '#trucksLineList',");return 'try { (0, eval)('+JSON.stringify(patch)+');';});
fs.writeFileSync('index-test.html',html);console.log('Built self-contained test HTML');
