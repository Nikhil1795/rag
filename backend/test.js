const { PDFParse } = require('pdf-parse');
const fs = require('fs');
async function test() {
  const buffer = fs.readFileSync('sample.pdf');
  const parser = new PDFParse({ data: buffer });
  const data = await parser.getText();
  console.log('Text preview:', data.text.substring(0, data.text.length));
  await parser.destroy();
}
test();