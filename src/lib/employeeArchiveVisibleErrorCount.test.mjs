import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const page = await readFile(new URL('../pages/AdminEmployeesPage.jsx', import.meta.url), 'utf8')
const styles = await readFile(new URL('../styles-employee-v27.css', import.meta.url), 'utf8')

test('employee archive shows total errors as its own compact column without truncating names', () => {
  assert.match(page, /<th className="employee-error-count-col">累计错误<\/th>/)
  assert.match(page, /className="employee-error-count-cell"[\s\S]+<strong>\{Number\(r\.total_error_count\|\|0\)\}<\/strong>/)
  assert.match(page, /<td className="employee-col-name"><span className="employee-name-value" title=\{r\.full_name\}>\{r\.full_name\}<\/span><\/td>/)
  assert.match(styles, /\.employee-master-table th\.employee-error-count-col,[\s\S]+width:68px;[\s\S]+text-align:center/)
  assert.doesNotMatch(page, /employee-name-secondary|employee-name-alias/)
})
