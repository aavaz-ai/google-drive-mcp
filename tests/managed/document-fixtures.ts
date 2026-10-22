import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";

export async function pdfFixture(text = "Authorized PDF content"): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage();
  if (text !== "") page.drawText(text);
  return document.save();
}

export async function officeFixture(format: string, text = "Authorized document content"): Promise<Uint8Array> {
  if (format === "rtf") return Buffer.from(`{\\rtf1\\ansi ${text}}`);
  const zip = new JSZip();
  const rels = "http://schemas.openxmlformats.org/package/2006/relationships";
  const office = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  zip.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  if (format === "docx") {
    zip.file("_rels/.rels", `<Relationships xmlns="${rels}"><Relationship Id="rId1" Type="${office}/officeDocument" Target="word/document.xml"/></Relationships>`);
    zip.file("word/document.xml", `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  } else if (format === "xlsx") {
    zip.file("xl/workbook.xml", `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${office}"><sheets><sheet name="Approved sheet" sheetId="1" r:id="rId1"/></sheets></workbook>`);
    zip.file("xl/_rels/workbook.xml.rels", `<Relationships xmlns="${rels}"><Relationship Id="rId1" Type="${office}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`);
    zip.file("xl/worksheets/sheet1.xml", `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${text}</t></is></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>`);
  } else if (format === "pptx") {
    zip.file("ppt/presentation.xml", `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${office}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`);
    zip.file("ppt/_rels/presentation.xml.rels", `<Relationships xmlns="${rels}"><Relationship Id="rId1" Type="${office}/slide" Target="slides/slide1.xml"/></Relationships>`);
    zip.file("ppt/slides/slide1.xml", `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`);
  } else {
    const kind = format === "odt" ? "text" : format === "ods" ? "spreadsheet" : "presentation";
    zip.file("mimetype", `application/vnd.oasis.opendocument.${kind}`);
    const content = format === "odt" ? `<text:p>${text}</text:p>` : format === "ods"
      ? `<table:table table:name="Approved sheet"><table:table-row><table:table-cell office:value-type="string"><text:p>${text}</text:p></table:table-cell></table:table-row></table:table>`
      : `<draw:page draw:name="Approved slide"><draw:frame><draw:text-box><text:p>${text}</text:p></draw:text-box></draw:frame></draw:page>`;
    zip.file("content.xml", `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"><office:body><office:${kind}>${content}</office:${kind}></office:body></office:document-content>`);
  }
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
