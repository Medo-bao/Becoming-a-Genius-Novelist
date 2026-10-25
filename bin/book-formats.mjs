/** TXT / DOCX / EPUB 导出；只使用 Node 内置模块。ZIP 的 CRC 是格式必需字段。 */
import { deflateRawSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'

const escapeXml = text => String(text).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch])
const plain = text => text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/^#{1,6}\s+/gm, '').replace(/^>\s?/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1')
const paragraphs = text => plain(text).split(/\r?\n/).filter(line => line.trim())
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let n = index
  for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1
  return n >>> 0
})
function crc32(data) {
  let value = 0xffffffff
  for (const byte of data) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}
function zip(entries) {
  const local = [], central = []
  let offset = 0
  for (const [name, content, stored = false] of entries) {
    const filename = Buffer.from(name), data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    const compressed = stored ? data : deflateRawSync(data), crc = crc32(data), header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x800, 6)
    header.writeUInt16LE(stored ? 0 : 8, 8)
    header.writeUInt16LE(33, 12)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(compressed.length, 18)
    header.writeUInt32LE(data.length, 22)
    header.writeUInt16LE(filename.length, 26)
    local.push(header, filename, compressed)
    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE(20, 4)
    header.copy(record, 6, 4, 28)
    record.writeUInt32LE(offset, 42)
    central.push(record, filename)
    offset += header.length + filename.length + compressed.length
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}
function docx(book) {
  const p = (text, style = '', bookmark = null) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${bookmark === null ? '' : `<w:bookmarkStart w:id="${bookmark}" w:name="chapter_${bookmark}"/>`}<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>${bookmark === null ? '' : `<w:bookmarkEnd w:id="${bookmark}"/>`}</w:p>`
  const toc = book.chapters.map((row, i) => `<w:p><w:hyperlink w:anchor="chapter_${i}"><w:r><w:t>${escapeXml(row.title)}</w:t></w:r></w:hyperlink></w:p>`).join('')
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${p(book.title, 'Title')}${book.author ? p(book.author) : ''}${book.description ? p(book.description) : ''}${p('目录', 'TOCHeading')}${toc}${book.chapters.map((row, i) => p(row.title, 'Heading1', i) + paragraphs(row.body).map(line => p(line)).join('')).join('')}<w:sectPr><w:footerReference w:type="default" r:id="rIdFooter"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:footer="720"/></w:sectPr></w:body></w:document>`
  return zip([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/document.xml', document],
    ['word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>'],
    ['word/footer1.xml', '<?xml version="1.0" encoding="UTF-8"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="center"/><w:ind w:firstLine="0"/></w:pPr><w:r><w:t>第 </w:t></w:r><w:fldSimple w:instr="PAGE"><w:r><w:t>1</w:t></w:r></w:fldSimple><w:r><w:t> 页</w:t></w:r></w:p></w:ftr>'],
    ['word/styles.xml', '<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="宋体"/><w:sz w:val="24"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="360" w:lineRule="auto"/><w:ind w:firstLine="480"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:ind w:firstLine="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="44"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="TOCHeading"><w:name w:val="TOC Heading"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:firstLine="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:pageBreakBefore/><w:ind w:firstLine="0"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:rFonts w:eastAsia="黑体"/><w:b/><w:sz w:val="32"/></w:rPr></w:style></w:styles>'],
  ])
}
function epub(book) {
  const id = `urn:uuid:${randomUUID()}`, stamp = book.date.toISOString().replace(/\.\d+Z$/, 'Z')
  const xhtml = (title, body) => `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXml(book.language ?? 'zh-CN')}" lang="${escapeXml(book.language ?? 'zh-CN')}"><head><title>${escapeXml(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body>${body}</body></html>`
  const coverName = book.cover?.type === 'image/png' ? 'cover.png' : 'cover.jpg'
  return zip([
    ['mimetype', 'application/epub+zip', true],
    ['META-INF/container.xml', '<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'],
    ['OEBPS/package.opf', `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">${id}</dc:identifier><dc:title>${escapeXml(book.title)}</dc:title><dc:language>${escapeXml(book.language ?? 'zh-CN')}</dc:language>${book.author ? `<dc:creator>${escapeXml(book.author)}</dc:creator>` : ''}${book.description ? `<dc:description>${escapeXml(book.description)}</dc:description>` : ''}<meta property="dcterms:modified">${stamp}</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="css" href="style.css" media-type="text/css"/>${book.cover ? `<item id="cover-image" href="${coverName}" media-type="${book.cover.type}" properties="cover-image"/><item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>` : ''}${book.chapters.map((_, i) => `<item id="ch${i + 1}" href="chapter-${i + 1}.xhtml" media-type="application/xhtml+xml"/>`).join('')}</manifest><spine>${book.cover ? '<itemref idref="cover"/>' : ''}${book.chapters.map((_, i) => `<itemref idref="ch${i + 1}"/>`).join('')}</spine></package>`],
    ['OEBPS/nav.xhtml', xhtml(book.title, `<nav epub:type="toc" id="toc"><h1>${escapeXml(book.title)}</h1><ol>${book.chapters.map((row, i) => `<li><a href="chapter-${i + 1}.xhtml">${escapeXml(row.title)}</a></li>`).join('')}</ol></nav>`)],
    ['OEBPS/style.css', 'body{font-family:serif;line-height:1.8;margin:5%;}h1{text-align:center;line-height:1.4;}p{text-indent:2em;margin:.4em 0;}nav ol{list-style:none;padding:0;}'],
    ...(book.cover ? [[`OEBPS/${coverName}`, book.cover.data], ['OEBPS/cover.xhtml', xhtml(book.title, `<section epub:type="cover"><img src="${coverName}" alt="${escapeXml(book.title)}" style="max-width:100%;height:auto"/></section>`)]] : []),
    ...book.chapters.map((row, i) => [`OEBPS/chapter-${i + 1}.xhtml`, xhtml(row.title, `<h1>${escapeXml(row.title)}</h1>${paragraphs(row.body).map(line => `<p>${escapeXml(line)}</p>`).join('')}`)]),
  ])
}
export function bookFormats(book, formats) {
  const outputs = new Map()
  for (const format of formats) {
    if (format === 'md') outputs.set(format, `# ${book.title}\n\n> ${book.chapters.length} 章｜${book.total} 汉字\n\n## 目录\n\n${book.chapters.map(row => `- ${row.title}`).join('\n')}\n\n${book.chapters.map(row => row.text.trim()).join('\n\n---\n\n')}\n`)
    if (format === 'txt') outputs.set(format, `\uFEFF《${book.title}》\r\n\r\n目录\r\n${book.chapters.map(row => row.title).join('\r\n')}\r\n\r\n${book.chapters.map(row => `${row.title}\r\n\r\n${plain(row.body).replace(/\r?\n/g, '\r\n')}`).join('\r\n\r\n')}\r\n`)
    if (format === 'docx') outputs.set(format, docx(book))
    if (format === 'epub') outputs.set(format, epub(book))
  }
  return outputs
}
