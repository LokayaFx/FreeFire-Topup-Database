const fs = require('fs');
const code = fs.readFileSync('index.js', 'utf8');

// Check for template literals - proper version
let inTemplate = false;
let templateStart = -1;
for (let i = 0; i < code.length; i++) {
  if (code[i] === '`') {
    // Check if escaped
    let escaped = false;
    let j = i - 1;
    let backslashCount = 0;
    while (j >= 0 && code[j] === '\\') {
      backslashCount++;
      j--;
    }
    escaped = backslashCount % 2 === 1;
    
    if (!escaped) {
      if (!inTemplate) {
        templateStart = i;
        inTemplate = true;
      } else {
        console.log(`Template ${templateStart}-${i}: ${JSON.stringify(code.slice(templateStart, i+1).substring(0, 80))}...`);
        inTemplate = false;
      }
    }
  }
}
console.log('In template at end:', inTemplate);
if (inTemplate) {
  console.log('Unclosed template starts at:', templateStart);
  console.log('Content:', JSON.stringify(code.slice(templateStart, templateStart+200)));
}

// Check for unclosed single quotes
let inSingle = false;
let singleStart = -1;
for (let i = 0; i < code.length; i++) {
  if (code[i] === "'") {
    let escaped = false;
    let j = i - 1;
    let backslashCount = 0;
    while (j >= 0 && code[j] === '\\') {
      backslashCount++;
      j--;
    }
    escaped = backslashCount % 2 === 1;
    
    if (!escaped) {
      if (!inSingle) {
        singleStart = i;
        inSingle = true;
      } else {
        inSingle = false;
      }
    }
  }
}
console.log('In single quote at end:', inSingle);
if (inSingle) {
  console.log('Unclosed single quote starts at:', singleStart);
  console.log('Content:', JSON.stringify(code.slice(singleStart, singleStart+200)));
}