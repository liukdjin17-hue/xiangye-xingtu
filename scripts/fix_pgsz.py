"""把 docx 的页面尺寸强制设为 A4（转换器默认会漏写 w:pgSz，Word 便按 Letter 排版）。"""
import re
import shutil
import sys
import zipfile

PG_SZ = '<w:pgSz w:w="11906" w:h="16838"/>'


def fix(path):
    tmp = path + '.tmp'
    with zipfile.ZipFile(path, 'r') as src, \
            zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as dst:
        for item in src.infolist():
            data = src.read(item.filename)
            if item.filename == 'word/document.xml':
                xml = data.decode('utf-8')
                if '<w:pgSz' not in xml:
                    xml = re.sub(r'(<w:pgMar)', PG_SZ + r'\1', xml, count=1)
                    if '<w:pgSz' not in xml:  # 没有 pgMar 的极端情况
                        xml = re.sub(r'(<w:sectPr[^>]*>)', r'\1' + PG_SZ, xml, count=1)
                data = xml.encode('utf-8')
            dst.writestr(item, data)
    shutil.move(tmp, path)


if __name__ == '__main__':
    for p in sys.argv[1:]:
        fix(p)
        with zipfile.ZipFile(p) as z:
            d = z.read('word/document.xml').decode('utf-8')
        print(p, '->', 'pgSz ok' if '<w:pgSz' in d else 'pgSz FAILED')
