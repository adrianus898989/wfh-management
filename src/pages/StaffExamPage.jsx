import React, { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useStaffLocale } from '../lib/staffI18n'
import { ExamImageGallery } from '../components/ExamImageGallery'

const copy = {
  eyebrow: ['WFH · 学习中心', 'WFH · LEARNING CENTER', 'WFH · TRUNG TÂM HỌC TẬP', 'WFH · PUSAT BELAJAR'],
  title: ['我的考试', 'My exams', 'Kỳ thi của tôi', 'Ujian saya'],
  refresh: ['刷新', 'Refresh', 'Làm mới', 'Muat ulang'],
  loading: ['正在读取考试…', 'Loading exams…', 'Đang tải kỳ thi…', 'Memuat ujian…'],
  available: ['可选考试', 'Available exams', 'Bài thi có thể chọn', 'Ujian tersedia'],
  history: ['历史考试', 'Exam history', 'Lịch sử thi', 'Riwayat ujian'],
  passed: ['已通过', 'Passed', 'Đã đạt', 'Lulus'],
  options: ['个组合', 'options', 'lựa chọn', 'pilihan'],
  records: ['次记录', 'records', 'bản ghi', 'catatan'],
  passedTimes: ['次通过', 'passes', 'lần đạt', 'kali lulus'],
  pickerEyebrow: ['自主选考', 'CHOOSE YOUR EXAM', 'TỰ CHỌN BÀI THI', 'PILIH UJIAN'],
  pickerTitle: ['选择考试', 'Choose an exam', 'Chọn bài thi', 'Pilih ujian'],
  pickerSubtitle: ['按题库来源的盘口和岗位选择可用试卷。', 'Choose an available exam by platform and position.', 'Chọn bài thi theo nền tảng và vị trí.', 'Pilih ujian berdasarkan platform dan posisi.'],
  platform: ['盘口', 'Platform', 'Nền tảng', 'Platform'],
  position: ['岗位', 'Position', 'Vị trí', 'Posisi'],
  selectPlatform: ['请选择', 'Select a platform', 'Chọn nền tảng', 'Pilih platform'],
  selectPosition: ['请选择', 'Select an exam', 'Chọn bài thi', 'Pilih ujian'],
  selected: ['当前选择', 'Selected exam', 'Bài thi đã chọn', 'Ujian terpilih'],
  inProgress: ['进行中', 'In progress', 'Đang làm', 'Sedang berlangsung'],
  questions: ['题目', 'Questions', 'Câu hỏi', 'Soal'],
  totalScore: ['总分', 'Total score', 'Tổng điểm', 'Total nilai'],
  minutes: ['分钟', 'Minutes', 'Phút', 'Menit'],
  passScore: ['及格', 'Pass score', 'Điểm đạt', 'Nilai lulus'],
  poolWarning: ['题库不足：5分题 {five}/10、10分题 {ten}/3、20分题 {twenty}/1。', 'Question pool incomplete: 5-point {five}/10, 10-point {ten}/3, 20-point {twenty}/1.', 'Ngân hàng câu hỏi chưa đủ: câu 5 điểm {five}/10, 10 điểm {ten}/3, 20 điểm {twenty}/1.', 'Bank soal belum lengkap: soal 5 poin {five}/10, 10 poin {ten}/3, 20 poin {twenty}/1.'],
  startConfirm: ['确认开始“{platform} · {position}”吗？开始后将连续计时 60 分钟。', 'Start “{platform} · {position}”? The 60-minute timer will begin immediately.', 'Bắt đầu “{platform} · {position}”? Đồng hồ 60 phút sẽ chạy ngay.', 'Mulai “{platform} · {position}”? Waktu 60 menit akan langsung berjalan.'],
  resume: ['继续考试', 'Resume exam', 'Tiếp tục', 'Lanjutkan'],
  start: ['开始考试', 'Start exam', 'Bắt đầu thi', 'Mulai ujian'],
  preparing: ['题库准备中', 'Question pool unavailable', 'Ngân hàng đề chưa sẵn sàng', 'Bank soal belum siap'],
  attemptsUsed: ['考试次数已用完', 'No attempts remaining', 'Đã hết lượt thi', 'Kesempatan ujian habis'],
  noExams: ['暂无可选考试', 'No exams available', 'Chưa có bài thi', 'Belum ada ujian'],
  noExamsText: ['管理员开放考试后，会在这里显示。', 'Available exams will appear here after an administrator enables them.', 'Bài thi sẽ hiển thị ở đây sau khi quản trị viên mở.', 'Ujian akan muncul di sini setelah diaktifkan admin.'],
  resultsEyebrow: ['我的成绩', 'MY RESULTS', 'KẾT QUẢ CỦA TÔI', 'HASIL SAYA'],
  resultsTitle: ['考试结果', 'Exam results', 'Kết quả thi', 'Hasil ujian'],
  source: ['来源', 'Source', 'Nguồn', 'Sumber'],
  exam: ['考试', 'Exam', 'Bài thi', 'Ujian'],
  attempt: ['次数', 'Attempt', 'Lần thi', 'Percobaan'],
  attemptValue: ['第 {count} 次', 'Attempt {count}', 'Lần {count}', 'Percobaan {count}'],
  startedAt: ['开始时间', 'Started', 'Bắt đầu', 'Mulai'],
  submittedAt: ['完成时间', 'Submitted', 'Hoàn thành', 'Dikumpulkan'],
  gradedAt: ['评分时间', 'Graded', 'Chấm điểm', 'Dinilai'],
  grade: ['成绩', 'Score', 'Điểm', 'Nilai'],
  answerResult: ['答题结果', 'Answer summary', 'Kết quả trả lời', 'Ringkasan jawaban'],
  result: ['结果', 'Result', 'Kết quả', 'Hasil'],
  action: ['操作', 'Action', 'Thao tác', 'Tindakan'],
  pending: ['待批改', 'Pending review', 'Chờ chấm', 'Menunggu penilaian'],
  pass: ['通过', 'Passed', 'Đạt', 'Lulus'],
  fail: ['未通过', 'Not passed', 'Chưa đạt', 'Belum lulus'],
  viewResult: ['查看结果', 'View result', 'Xem kết quả', 'Lihat hasil'],
  noHistory: ['完成考试后，成绩会显示在这里。', 'Completed exams will appear here.', 'Bài thi đã hoàn thành sẽ hiển thị ở đây.', 'Ujian yang selesai akan muncul di sini.'],
  detailWaiting: ['逐题明细等待同步', 'Per-question details awaiting sync', 'Chi tiết từng câu đang chờ đồng bộ', 'Detail per soal menunggu sinkronisasi'],
  totalOnly: ['总成绩已保留 · 逐题明细未同步', 'Final score saved · details not synced', 'Đã lưu tổng điểm · chưa đồng bộ chi tiết', 'Nilai akhir tersimpan · detail belum disinkronkan'],
  breakdown: ['正确 {correct} · 半对 {partial} · 错误 {wrong} · 待评 {pending}', 'Correct {correct} · Partial {partial} · Wrong {wrong} · Pending {pending}', 'Đúng {correct} · Nửa đúng {partial} · Sai {wrong} · Chờ {pending}', 'Benar {correct} · Sebagian {partial} · Salah {wrong} · Menunggu {pending}'],
  breakdownAnswered: ['已答 {answered}/{total} · 未答 {unanswered} · {detail}', 'Answered {answered}/{total} · Unanswered {unanswered} · {detail}', 'Đã trả lời {answered}/{total} · Chưa trả lời {unanswered} · {detail}', 'Dijawab {answered}/{total} · Belum dijawab {unanswered} · {detail}'],
  resultTitle: ['我的考试结果', 'MY EXAM RESULT', 'KẾT QUẢ BÀI THI', 'HASIL UJIAN SAYA'],
  score: ['成绩', 'Score', 'Điểm', 'Nilai'],
  awarded: ['得分', 'Points', 'Điểm số', 'Poin'],
  answerStats: ['答题统计', 'Answer summary', 'Thống kê câu trả lời', 'Ringkasan jawaban'],
  overallFeedback: ['总体评语', 'Overall feedback', 'Nhận xét chung', 'Catatan keseluruhan'],
  questionPoints: ['本题 {count} 分', '{count} points', '{count} điểm', '{count} poin'],
  showLanguages: ['查看其他语言', 'Show other languages', 'Xem ngôn ngữ khác', 'Lihat bahasa lain'],
  myAnswer: ['我的答案', 'My answer', 'Câu trả lời của tôi', 'Jawaban saya'],
  unanswered: ['（未作答）', '(No answer)', '(Chưa trả lời)', '(Belum dijawab)'],
  feedback: ['老师评语', 'Reviewer feedback', 'Nhận xét người chấm', 'Catatan penilai'],
  noFeedback: ['老师未填写评语', 'No feedback provided', 'Chưa có nhận xét', 'Tidak ada catatan'],
  noAnswerDetails: ['该场考试没有可显示的逐题明细。', 'No per-question details are available for this exam.', 'Không có chi tiết từng câu cho bài thi này.', 'Detail per soal tidak tersedia untuk ujian ini.'],
  resultLoading: ['正在读取逐题结果…', 'Loading result details…', 'Đang tải chi tiết kết quả…', 'Memuat detail hasil…'],
  resultLoadFailed: ['考试结果读取失败', 'Could not load the exam result', 'Không thể tải kết quả thi', 'Hasil ujian tidak dapat dimuat'],
  retry: ['重试', 'Retry', 'Thử lại', 'Coba lagi'],
  close: ['关闭', 'Close', 'Đóng', 'Tutup'],
  onlineExam: ['在线考试', 'ONLINE EXAM', 'BÀI THI TRỰC TUYẾN', 'UJIAN ONLINE'],
  runningExam: ['正在考试', 'Exam in progress', 'Đang thi', 'Ujian berlangsung'],
  runnerSummary: ['{count} 题 · 100 分 · 答案自动保存', '{count} questions · 100 points · Answers auto-save', '{count} câu · 100 điểm · Tự động lưu', '{count} soal · 100 poin · Jawaban tersimpan otomatis'],
  timeLeft: ['剩余时间', 'Time remaining', 'Thời gian còn lại', 'Sisa waktu'],
  progress: ['答题进度', 'Progress', 'Tiến độ', 'Progres'],
  answered: ['已答 {answered} / {total}', 'Answered {answered} / {total}', 'Đã trả lời {answered} / {total}', 'Dijawab {answered} / {total}'],
  questionIndex: ['第 {current} 题 / 共 {total} 题', 'Question {current} of {total}', 'Câu {current} / {total}', 'Soal {current} dari {total}'],
  difficulty: ['{points} 分 · 难度 {difficulty}', '{points} pts · Difficulty {difficulty}', '{points} điểm · Độ khó {difficulty}', '{points} poin · Kesulitan {difficulty}'],
  answerLabel: ['填写答案', 'Your answer', 'Câu trả lời', 'Jawaban Anda'],
  answerPlaceholder: ['请输入完整回答…', 'Enter your complete answer…', 'Nhập câu trả lời đầy đủ…', 'Masukkan jawaban lengkap…'],
  previous: ['上一题', 'Previous', 'Câu trước', 'Sebelumnya'],
  next: ['下一题', 'Next', 'Câu tiếp', 'Berikutnya'],
  submit: ['提交考试', 'Submit exam', 'Nộp bài', 'Kirim ujian'],
  saving: ['正在保存…', 'Saving…', 'Đang lưu…', 'Menyimpan…'],
  saved: ['答案已自动保存', 'Answer saved automatically', 'Đã tự động lưu', 'Jawaban tersimpan otomatis'],
  saveFailed: ['答案保存失败：{error}', 'Could not save answer: {error}', 'Không thể lưu câu trả lời: {error}', 'Jawaban gagal disimpan: {error}'],
  submitConfirm: ['提交后不能再修改，确认提交？', 'You cannot edit after submission. Submit now?', 'Không thể sửa sau khi nộp. Xác nhận nộp?', 'Jawaban tidak dapat diubah setelah dikirim. Kirim sekarang?'],
  autoSubmitted: ['考试时间到，已自动提交。', 'Time is up. Your exam was submitted automatically.', 'Hết giờ. Bài thi đã được tự động nộp.', 'Waktu habis. Ujian dikirim otomatis.'],
  submitted: ['考试已提交，等待后台批改。', 'Exam submitted and awaiting review.', 'Đã nộp bài và đang chờ chấm.', 'Ujian dikirim dan menunggu penilaian.'],
  noQuestions: ['试卷没有可用题目，请联系管理员。', 'This exam has no available questions. Please contact an administrator.', 'Bài thi không có câu hỏi. Vui lòng liên hệ quản trị viên.', 'Ujian ini tidak memiliki soal. Hubungi administrator.'],
  imageClose: ['关闭图片', 'Close image', 'Đóng ảnh', 'Tutup gambar'],
  imageAlt: ['考试题目图片', 'Exam question image', 'Ảnh câu hỏi', 'Gambar soal'],
  imageOpen: ['点击放大', 'Enlarge', 'Phóng to', 'Perbesar'],
  imageFallback: ['图片暂时无法预览，请在弹窗内重试', 'Preview unavailable. Retry in this window.', 'Không thể xem trước. Hãy thử lại trong cửa sổ này.', 'Pratinjau tidak tersedia. Coba lagi di jendela ini.'],
  imageNumber: ['图片 {count}', 'Image {count}', 'Hình {count}', 'Gambar {count}'],
}

const languageIndex = { zh: 0, en: 1, vi: 2, id: 3 }
const dateLocale = { zh: 'zh-CN', en: 'en-US', vi: 'vi-VN', id: 'id-ID' }
const msg = error => error?.message || String(error || 'Request failed')
const template = (value, vars = {}) => String(value).replace(/\{(\w+)\}/g, (match, key) => vars[key] ?? match)
const baseText = (locale, key) => copy[key]?.[languageIndex[locale] ?? 1] || copy[key]?.[1] || key
const fmt = (value, locale) => value ? new Date(value).toLocaleString(dateLocale[locale] || 'en-US', { hour12: false }) : '—'
const score = (value, locale) => value == null ? '—' : Number(value).toLocaleString(dateLocale[locale] || 'en-US', { maximumFractionDigits: 2 })
const cleanLabel = value => String(value || '').trim().replace(/\s+/g, ' ')
const normalizedLabel = value => cleanLabel(value).normalize('NFKC').toLocaleLowerCase()
const optionKey = exam => JSON.stringify(
  [exam?.series_name, exam?.position_name].map(normalizedLabel),
)
const optionRank = exam => {
  const attempts = Number(exam?.attempts || 0)
  const maximum = Number(exam?.max_attempts || 0)
  return (exam?.resume_session_id ? 100 : 0) + (exam?.pool_ready ? 20 : 0) + (!maximum || attempts < maximum ? 5 : 0)
}
const cleanOptions = values => [...values.reduce((options, value) => {
  const label = cleanLabel(value)
  const key = normalizedLabel(label)
  if (key && !options.has(key)) options.set(key, label)
  return options
}, new Map()).values()].sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }))

function useExamText() {
  const { locale, setLocale, t } = useStaffLocale()
  const tr = (key, vars) => t(`staff.exam.${key}`, baseText(locale, key), vars)
  return { locale, setLocale, tr, languageLabel: t('language.choose', 'Language') }
}

function answerBreakdown(item, tr) {
  if (item.source_system === 'legacy' && !item.answer_detail_available) return item.percentage == null ? tr('detailWaiting') : tr('totalOnly')
  const answered = Number(item.answer_detail_count || 0)
  const total = Number(item.total_question_count || 0)
  const unanswered = Number(item.unanswered_count || Math.max(total - answered, 0))
  const detail = tr('breakdown', { correct: item.correct_count || 0, partial: item.partial_count || 0, wrong: item.wrong_count || 0, pending: item.pending_count || 0 })
  return item.source_system === 'legacy' && total ? tr('breakdownAnswered', { answered, total, unanswered, detail }) : detail
}

export default function StaffExamPage() {
  const { locale, setLocale, tr, languageLabel } = useExamText()
  const [home, setHome] = useState(null)
  const [session, setSession] = useState(null)
  const [resultState, setResultState] = useState(null)
  const [answers, setAnswers] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selectedPlatform, setSelectedPlatform] = useState('')
  const [selectedExamKey, setSelectedExamKey] = useState('')
  const resultRequest = useRef(0)

  const load = async () => {
    // A refresh or a retained route must always return to an explicit choice.
    // Never carry the first/previous platform and position into a new visit.
    setSelectedPlatform('')
    setSelectedExamKey('')
    setLoading(true)
    const { data, error: requestError } = await supabase.rpc('staff_exam_home')
    if (requestError) setError(msg(requestError))
    else { setHome(data); setError('') }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const assignments = useMemo(() => {
    const unique = new Map()
    for (const exam of home?.assignments || []) {
      if (!exam.pool_ready && !exam.resume_session_id) continue
      const key = optionKey(exam)
      const previous = unique.get(key)
      if (!previous || optionRank(exam) > optionRank(previous)) unique.set(key, exam)
    }
    return [...unique.values()].sort((left, right) => {
      const platform = String(left.series_name || '').localeCompare(String(right.series_name || ''), undefined, { numeric: true, sensitivity: 'base' })
      return platform || String(left.position_name || '').localeCompare(String(right.position_name || ''), undefined, { numeric: true, sensitivity: 'base' })
    })
  }, [home])

  useEffect(() => {
    if (!assignments.length) {
      setSelectedPlatform(''); setSelectedExamKey('')
      return
    }
    const platformStillAvailable = !selectedPlatform || assignments.some(exam => normalizedLabel(exam.series_name) === normalizedLabel(selectedPlatform))
    if (!platformStillAvailable) {
      setSelectedPlatform('')
      setSelectedExamKey('')
      return
    }
    if (selectedExamKey && !assignments.some(exam => optionKey(exam) === selectedExamKey)) setSelectedExamKey('')
  }, [assignments, selectedPlatform, selectedExamKey])

  const platformOptions = useMemo(() => cleanOptions(assignments.map(exam => exam.series_name)), [assignments])
  const positionOptions = useMemo(() => assignments.filter(exam => normalizedLabel(exam.series_name) === normalizedLabel(selectedPlatform)), [assignments, selectedPlatform])
  const selectedExam = assignments.find(exam => optionKey(exam) === selectedExamKey) || null
  const history = home?.history || []
  const passedCount = history.filter(item => item.status === 'graded' && item.passed).length

  const choosePlatform = value => {
    setSelectedPlatform(value)
    setSelectedExamKey('')
  }

  const start = async exam => {
    if (!exam) return
    if (!exam.resume_session_id && !window.confirm(tr('startConfirm', { platform: exam.series_name || '—', position: exam.position_name || '—' }))) return
    const { data, error: requestError } = await supabase.rpc('staff_exam_start_open', {
      p_team: exam.team_name,
      p_series: exam.series_name,
      p_position: exam.position_name,
    })
    if (requestError) return setError(msg(requestError))
    setSession(data)
    setAnswers(data?.saved_answers || {})
  }

  const viewResult = async item => {
    const requestId = ++resultRequest.current
    setResultState({ loading: true, error: '', data: null, preview: item })
    const { data, error: requestError } = await supabase.rpc('staff_exam_result_detail', { p_session_id: item.id })
    if (requestId !== resultRequest.current) return
    if (requestError) {
      setResultState({ loading: false, error: msg(requestError), data: null, preview: item })
      return
    }
    setResultState({ loading: false, error: '', data, preview: item })
  }

  const closeResult = () => { resultRequest.current += 1; setResultState(null) }

  if (session) return <ExamRunner session={session} answers={answers} setAnswers={setAnswers} onDone={() => { setSession(null); load() }} />

  const attempts = Number(selectedExam?.attempts || 0)
  const maxAttempts = Number(selectedExam?.max_attempts || 0)
  const attemptsExhausted = Boolean(selectedExam && !selectedExam.resume_session_id && maxAttempts > 0 && attempts >= maxAttempts)

  return <div className="staff-exam-page staff-exam-page-compact">
    <header className="staff-exam-hero">
      <div>
        <small>{tr('eyebrow')}</small>
        <h1>{tr('title')}</h1>
        <p>{home?.profile ? `${home.profile.employee_no} · ${home.profile.employee_name}` : ''}</p>
      </div>
      <div className="staff-exam-hero-actions">
        <label className="staff-exam-locale">
          <span>{languageLabel}</span>
          <select value={locale} onChange={event => setLocale(event.target.value)} aria-label={languageLabel}>
            <option value="zh">中文</option><option value="en">English</option><option value="vi">Tiếng Việt</option><option value="id">Bahasa Indonesia</option>
          </select>
        </label>
        <button onClick={load}>↻ {tr('refresh')}</button>
      </div>
    </header>

    {error && <div className="exam-error">{error}<button className="exam-inline-close" onClick={() => setError('')} aria-label={tr('close')}>×</button></div>}
    {loading ? <div className="exam-empty staff-exam-loading">{tr('loading')}</div> : <>
      <div className="staff-exam-metrics">
        <div><span>{tr('available')}</span><strong>{assignments.length}</strong><small>{tr('options')}</small></div>
        <div><span>{tr('history')}</span><strong>{history.length}</strong><small>{tr('records')}</small></div>
        <div><span>{tr('passed')}</span><strong>{passedCount}</strong><small>{tr('passedTimes')}</small></div>
      </div>

      <section className="staff-pending-section">
        <div className="staff-section-head"><div><small>{tr('pickerEyebrow')}</small><h2>{tr('pickerTitle')}</h2><p>{tr('pickerSubtitle')}</p></div></div>
        {assignments.length ? <div className="staff-exam-picker">
          <div className="staff-exam-picker-controls">
            <label><span>{tr('platform')}</span><select value={selectedPlatform} onChange={event => choosePlatform(event.target.value)}><option value="">{tr('selectPlatform')}</option>{platformOptions.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
            <label><span>{tr('position')}</span><select value={selectedExamKey} onChange={event => setSelectedExamKey(event.target.value)} disabled={!selectedPlatform}><option value="">{tr('selectPosition')}</option>{positionOptions.map(exam => <option key={optionKey(exam)} value={optionKey(exam)}>{cleanLabel(exam.position_name)}</option>)}</select></label>
          </div>

          {selectedExam && <div className="staff-exam-selection">
            <div className="staff-exam-selection-main">
              <small>{tr('selected')}</small>
              <strong>{cleanLabel(selectedExam.series_name)}</strong>
              <span>{cleanLabel(selectedExam.position_name)}</span>
              {selectedExam.resume_session_id && <em>{tr('inProgress')}</em>}
            </div>
            <div className="staff-exam-selection-facts">
              <b>14<small>{tr('questions')}</small></b>
              <b>100<small>{tr('totalScore')}</small></b>
              <b>60<small>{tr('minutes')}</small></b>
              <b>{selectedExam.pass_score ?? 60}%<small>{tr('passScore')}</small></b>
            </div>
            {!selectedExam.pool_ready && <div className="pool-warning">{tr('poolWarning', { five: selectedExam.pool_counts?.[5] || 0, ten: selectedExam.pool_counts?.[10] || 0, twenty: selectedExam.pool_counts?.[20] || 0 })}</div>}
            <button className="staff-exam-start" disabled={!selectedExam.pool_ready || attemptsExhausted} onClick={() => start(selectedExam)}>{selectedExam.resume_session_id ? tr('resume') : !selectedExam.pool_ready ? tr('preparing') : attemptsExhausted ? tr('attemptsUsed') : tr('start')} <span>→</span></button>
          </div>}
        </div> : <div className="staff-empty-state compact"><span>!</span><h3>{tr('noExams')}</h3><p>{tr('noExamsText')}</p></div>}
      </section>

      <section className="staff-exam-results-section">
        <div className="staff-section-head"><div><small>{tr('resultsEyebrow')}</small><h2>{tr('resultsTitle')}</h2></div><span>{history.length}</span></div>
        {history.length ? <div className="exam-table-wrap"><table className="exam-table staff-history-table"><thead><tr><th>{tr('source')}</th><th>{tr('exam')}</th><th>{tr('attempt')}</th><th>{tr('startedAt')}</th><th>{tr('submittedAt')}</th><th>{tr('gradedAt')}</th><th>{tr('grade')}</th><th>{tr('answerResult')}</th><th>{tr('result')}</th><th>{tr('action')}</th></tr></thead><tbody>{history.map(item => <tr key={`${item.source_system || 'current'}-${item.id}`}>
          <td><span className={`exam-source-badge ${item.source_system === 'legacy' ? 'legacy' : 'current'}`}>{item.source_label || '—'}</span></td>
          <td><strong>{item.title}</strong></td><td>{tr('attemptValue', { count: item.attempt_no })}</td>
          <td>{fmt(item.started_at, locale)}</td><td>{fmt(item.submitted_at, locale)}</td><td>{fmt(item.graded_at, locale)}</td>
          <td><b>{item.percentage == null ? tr('pending') : `${score(item.earned_score, locale)}/${score(item.total_score, locale)} · ${score(item.percentage, locale)}%`}</b></td>
          <td><span className="staff-history-breakdown">{answerBreakdown(item, tr)}</span></td>
          <td><span className={`result-chip ${item.status === 'graded' ? (item.passed ? 'pass' : 'fail') : 'pending'}`}>{item.status === 'graded' ? (item.passed ? tr('pass') : tr('fail')) : tr('pending')}</span></td>
          <td><button className="exam-table-action" onClick={() => viewResult(item)}>{tr('viewResult')}</button></td>
        </tr>)}</tbody></table></div> : <div className="staff-history-empty">{tr('noHistory')}</div>}
      </section>
      {resultState && <ExamResult state={resultState} onClose={closeResult} onRetry={() => viewResult(resultState.preview)} />}
    </>}
  </div>
}

function ExamResult({ state, onClose, onRetry }) {
  const { locale, tr } = useExamText()
  const session = state?.data?.session || state?.preview || {}
  const items = state?.data?.answers || []

  useEffect(() => {
    const closeOnEscape = event => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  return <div className="exam-modal-backdrop" onMouseDown={event => { if (event.currentTarget === event.target) onClose() }}>
    <div className="exam-modal wide staff-result-modal" role="dialog" aria-modal="true" aria-labelledby="staff-exam-result-title">
      <header><div><small>{tr('resultTitle')}</small><h2 id="staff-exam-result-title">{session.title || tr('resultsTitle')}</h2><p>{tr('attemptValue', { count: session.attempt_no || 1 })}</p></div><button type="button" className="exam-icon-close" onClick={onClose} aria-label={tr('close')}>×</button></header>
      {state.loading ? <ExamResultSkeleton label={tr('resultLoading')} /> : state.error ? <div className="staff-result-load-error" role="alert"><strong>{tr('resultLoadFailed')}</strong><p>{state.error}</p><button type="button" onClick={onRetry}>↻ {tr('retry')}</button></div> : <>
        <div className="staff-result-summary">
          <div><span>{tr('score')}</span><strong>{session.percentage == null ? tr('pending') : `${score(session.percentage, locale)}%`}</strong></div>
          <div><span>{tr('result')}</span><strong>{session.status === 'graded' ? (session.passed ? tr('pass') : tr('fail')) : tr('pending')}</strong></div>
          <div><span>{tr('awarded')}</span><strong>{score(session.earned_score, locale)} / {score(session.total_score, locale)}</strong></div>
          <div><span>{tr('answerStats')}</span><strong>{answerBreakdown(session, tr)}</strong></div>
        </div>
        <div className="staff-result-audit"><span><b>{tr('startedAt')}</b>{fmt(session.started_at, locale)}</span><span><b>{tr('submittedAt')}</b>{fmt(session.submitted_at, locale)}</span><span><b>{tr('gradedAt')}</b>{fmt(session.graded_at, locale)}</span></div>
        {session.grader_note && <div className="staff-result-note"><b>{tr('overallFeedback')}</b><p>{session.grader_note}</p></div>}
        {items.length ? <div className="staff-result-list">{items.map((item, index) => {
        const question = item.question || {}
        const gradeState = item.grade_status === 'correct' ? 'pass' : item.grade_status === 'partial' ? 'partial' : item.grade_status === 'wrong' ? 'fail' : 'pending'
        return <article key={question.id || index}><header><b>{index + 1}</b><div><strong>{preferredQuestion(question, locale)}</strong><small>{tr('questionPoints', { count: score(question.points, locale) })}</small></div><span className={`result-chip ${gradeState}`}>{item.awarded_score == null ? tr('pending') : `${score(item.awarded_score, locale)}/${score(question.points, locale)}`}</span></header>
          <QuestionTranslations question={question} locale={locale} label={tr('showLanguages')} />
          <ExamMedia urls={question.image_urls} />
          <div className="staff-result-answer"><b>{tr('myAnswer')}</b><p>{item.answer_text || tr('unanswered')}</p></div>
          {item.awarded_score != null && <div className="staff-result-feedback"><b>{tr('feedback')}</b><p>{item.grader_feedback || tr('noFeedback')}</p><small>{tr('gradedAt')} · {fmt(item.graded_at || session.graded_at, locale)}</small></div>}
        </article>
        })}</div> : <div className="staff-history-empty result-empty">{tr('noAnswerDetails')}</div>}
      </>}
      <footer><button type="button" className="exam-footer-close" onClick={onClose}>{tr('close')}</button></footer>
    </div>
  </div>
}

function ExamResultSkeleton({ label }) {
  return <div className="staff-result-skeleton" aria-live="polite" aria-busy="true">
    <div className="staff-result-skeleton-label"><span className="exam-loading-spinner" />{label}</div>
    <div className="staff-result-skeleton-summary">{[0, 1, 2, 3].map(value => <i key={value} />)}</div>
    <div className="staff-result-skeleton-list">{[0, 1, 2].map(value => <i key={value} />)}</div>
  </div>
}

function preferredQuestion(question, locale) {
  if (locale === 'zh') return question.question_zh || question.question_en || question.question_vi || '—'
  if (locale === 'vi') return question.question_vi || question.question_en || question.question_zh || '—'
  return question.question_en || question.question_zh || question.question_vi || '—'
}

function QuestionTranslations({ question, locale, label }) {
  const rows = [['ZH', question.question_zh, 'zh'], ['EN', question.question_en, 'en'], ['VI', question.question_vi, 'vi']].filter(([, value, code]) => value && code !== locale)
  if (!rows.length) return null
  return <details><summary>{label}</summary>{rows.map(([language, value]) => <p key={language}><b>{language}</b><span>{value}</span></p>)}</details>
}

function ExamRunner({ session, answers, setAnswers, onDone }) {
  const { locale, tr } = useExamText()
  const questions = session.question_snapshot || []
  const [index, setIndex] = useState(0)
  const [remaining, setRemaining] = useState(Math.max(0, Math.floor((new Date(session.expires_at) - Date.now()) / 1000)))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const submitting = useRef(false)
  const question = questions[index]
  const answer = answers[question?.id] || ''

  useEffect(() => { const timer = window.setInterval(() => setRemaining(value => Math.max(0, value - 1)), 1000); return () => window.clearInterval(timer) }, [])
  useEffect(() => { if (remaining === 0) submit(true) }, [remaining])

  const save = async (targetQuestion = question, value = answer) => {
    if (!targetQuestion) return true
    setSaving(true)
    const { error: requestError } = await supabase.rpc('staff_exam_save_answer', { p_session_id: session.id, p_question_id: targetQuestion.id, p_answer: value, p_attachments: [] })
    setSaving(false)
    if (requestError) { setError(tr('saveFailed', { error: msg(requestError) })); return false }
    setError('')
    return true
  }

  const go = async nextIndex => { await save(); setIndex(nextIndex) }
  const submit = async (automatic = false) => {
    if (submitting.current) return
    if (!automatic && !window.confirm(tr('submitConfirm'))) return
    submitting.current = true
    const saved = await save()
    if (!saved && !automatic) { submitting.current = false; return }
    const { error: requestError } = await supabase.rpc('staff_exam_submit', { p_session_id: session.id })
    if (requestError) { submitting.current = false; setError(msg(requestError)); return }
    window.alert(automatic ? tr('autoSubmitted') : tr('submitted'))
    onDone()
  }

  const minutes = String(Math.floor(remaining / 60)).padStart(2, '0')
  const seconds = String(remaining % 60).padStart(2, '0')
  if (!question) return <div className="exam-empty">{tr('noQuestions')}</div>
  const languageRows = locale === 'zh'
    ? [['中', question.question_zh], ['EN', question.question_en], ['VI', question.question_vi]]
    : locale === 'vi'
      ? [['VI', question.question_vi], ['EN', question.question_en], ['中', question.question_zh]]
      : [['EN', question.question_en], ['中', question.question_zh], ['VI', question.question_vi]]

  return <div className="exam-runner">
    <header><div><small>{tr('onlineExam')}</small><h1>{session.title || tr('runningExam')}</h1><p>{tr('runnerSummary', { count: questions.length })}</p></div><div className={remaining < 300 ? 'timer danger' : 'timer'}><small>{tr('timeLeft')}</small><strong>{minutes}:{seconds}</strong></div></header>
    {error && <div className="exam-error runner-error">{error}</div>}
    <div className="runner-layout"><aside><strong>{tr('progress')}</strong><div className="question-nav">{questions.map((item, questionIndex) => <button key={item.id} className={`${questionIndex === index ? 'active' : ''} ${answers[item.id]?.trim() ? 'done' : ''}`} onClick={() => go(questionIndex)}>{questionIndex + 1}</button>)}</div><p>{tr('answered', { answered: Object.values(answers).filter(value => String(value || '').trim()).length, total: questions.length })}</p></aside>
      <main><div className="question-head"><span>{tr('questionIndex', { current: index + 1, total: questions.length })}</span><b>{tr('difficulty', { points: question.points, difficulty: question.difficulty })}</b></div><div className="runner-languages">{languageRows.filter(([, value]) => value).map(([language, value]) => <div key={language}><span>{language}</span><p>{value}</p></div>)}</div><ExamMedia urls={question.image_urls} /><label>{tr('answerLabel')}<textarea autoFocus value={answer} onChange={event => setAnswers({ ...answers, [question.id]: event.target.value })} onBlur={() => save(question, answers[question.id] || '')} placeholder={tr('answerPlaceholder')} /></label><footer><button disabled={index === 0} onClick={() => go(index - 1)}>{tr('previous')}</button><span>{saving ? tr('saving') : tr('saved')}</span>{index < questions.length - 1 ? <button className="primary" onClick={() => go(index + 1)}>{tr('next')}</button> : <button className="primary" onClick={() => submit(false)}>{tr('submit')}</button>}</footer></main>
    </div>
  </div>
}

function ExamMedia({ urls = [] }) {
  const { tr } = useExamText()
  return <ExamImageGallery urls={urls} labels={{
    imageAlt:tr('imageAlt'),
    imageOpen:tr('imageOpen'),
    imageClose:tr('imageClose'),
    imageFallback:tr('imageFallback'),
    imageRetry:tr('retry'),
    imageNumber:count=>tr('imageNumber',{count}),
  }}/>
}
