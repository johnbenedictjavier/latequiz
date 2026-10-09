import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  Bell,
  BookOpen,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  ClipboardCheck,
  Clock3,
  Code2,
  Eye,
  EyeOff,
  FileText,
  FileUp,
  FolderKanban,
  GraduationCap,
  HelpCircle,
  ImagePlus,
  Home,
  LayoutDashboard,
  Layers3,
  ListChecks,
  LockKeyhole,
  LogOut,
  Menu,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Target,
  Trash2,
  Upload,
  UserRound,
  UsersRound,
  X,
} from 'lucide-react'
import { assignQuiz, DEFAULT_STUDENT_PASSWORD, deleteQuiz, loadQuizAssignments, provisionStudentAccounts, resetStudentPassword, saveQuiz, saveStudent, setQuizStatus } from './lib/admin'
import { saveAttemptAnswers, startAttempt, submitAttempt, type AttemptSubmissionResult } from './lib/attempts'
import { changePassword, requestPasswordReset, signInWithAdminUsername, signInWithSchoolId, signOut } from './lib/auth'
import { importQuizPdf } from './lib/pdfImport'
import { removeAvatar, signedAvatarUrl, uploadAvatar } from './lib/profile'
import { isSupabaseConfigured, supabase } from './lib/supabase'
import { deleteSubmission, loadAdminSubmissions, reviewSubmission } from './lib/submissions'
import { sortStudents } from './lib/sorting'
import { createSubject, loadAdminNotifications, loadAdminQuizzes, loadAdminRoster, loadStudentWorkspace, loadSubjects, markNotificationRead } from './lib/workspace'
import type { AdminView, Notification, Question, Quiz, QuizPart, Role, ScoreRecord, Student, StudentView, Subject, Submission, SubmissionAnswer, SubmissionPartColumn, ToastMessage } from './types'
import latequizLogo from '../latequiz.png'

type AuthRoute = 'student' | 'admin'

const DEFAULT_SUBJECT = 'Architecture and Organization'

function newId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

function displayName(student: Student) {
  return `${student.firstNames} ${student.lastName}`.trim().split(' ').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')
}

function initials(student: Student) {
  return `${student.firstNames.charAt(0)}${student.lastName.charAt(0)}`.toUpperCase()
}

function currentGreeting(date = new Date()) {
  const hour = date.getHours()
  if (hour === 12) return 'Good noon'
  if (hour >= 5 && hour < 12) return 'Good morning'
  if (hour >= 13 && hour < 18) return 'Good afternoon'
  return 'Good night'
}

function currentDateLabel(date = new Date()) {
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}

function useToast() {
  const [toast, setToast] = useState<ToastMessage | null>(null)
  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 4200)
    return () => window.clearTimeout(timer)
  }, [toast])
  return { toast, notify: setToast }
}

function useCurrentTime() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

export default function App() {
  const [authRoute, setAuthRoute] = useState<AuthRoute>(() => new URLSearchParams(window.location.search).get('role') === 'admin' || window.location.pathname.startsWith('/admin') ? 'admin' : 'student')
  const [role, setRole] = useState<Role | null>(null)
  const [authReady, setAuthReady] = useState(!supabase)
  const [student, setStudent] = useState<Student | null>(null)
  const [mustChangePassword, setMustChangePassword] = useState(false)
  const [studentView, setStudentView] = useState<StudentView>('dashboard')
  const [adminView, setAdminView] = useState<AdminView>('overview')
  const [selectedQuizId, setSelectedQuizId] = useState('')
  const [builderQuizId, setBuilderQuizId] = useState<string | null>(null)
  const [isBuilderNew, setIsBuilderNew] = useState(false)
  const [selectedQuiz, setSelectedQuiz] = useState<Quiz | null>(null)
  const [quizzes, setQuizzes] = useState<Quiz[]>([])
  const [adminQuizzes, setAdminQuizzes] = useState<Quiz[]>([])
  const [scores, setScores] = useState<ScoreRecord[]>([])
  const [pendingQuiz, setPendingQuiz] = useState<Quiz | null>(null)
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false)
  const [isLoggingOut, setIsLoggingOut] = useState(false)
  const { toast, notify } = useToast()

  useEffect(() => {
    const favicon = document.getElementById('latequiz-favicon') as HTMLLinkElement | null
    if (favicon) favicon.href = latequizLogo
  }, [])

  const navigateAuth = (next: AuthRoute) => {
    const path = next === 'admin' ? '/login?role=admin' : '/login'
    window.history.pushState({}, '', path)
    setAuthRoute(next)
  }

  const applyLogin = (nextRole: Role, nextStudent?: Student, forcePasswordChange = false) => {
    setRole(nextRole)
    setStudent(nextStudent ?? null)
    setMustChangePassword(forcePasswordChange && nextRole === 'student')
  }

  const clearSessionState = () => {
    setRole(null)
    setStudent(null)
    setMustChangePassword(false)
    setQuizzes([])
    setScores([])
    setAdminQuizzes([])
    setSelectedQuiz(null)
    setPendingQuiz(null)
  }

  useEffect(() => {
    const onPopState = () => setAuthRoute(new URLSearchParams(window.location.search).get('role') === 'admin' || window.location.pathname.startsWith('/admin') ? 'admin' : 'student')
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    if (!supabase) {
      setAuthReady(true)
      return
    }

    const client = supabase
    let active = true
    const restoreSession = async () => {
      const { data: sessionData, error: sessionError } = await client.auth.getSession()
      if (!active) return
      const user = sessionData.session?.user
      if (sessionError || !user) {
        setAuthReady(true)
        return
      }

      const { data: profile, error: profileError } = await client.from('LQ_profiles').select('role, school_id, must_change_password, avatar_url').eq('id', user.id).maybeSingle()
      if (!active) return
      if (profileError || !profile) {
        await client.auth.signOut()
        if (active) {
          clearSessionState()
          setAuthReady(true)
        }
        return
      }
      if (profile.role === 'admin') {
        applyLogin('admin')
        setAuthReady(true)
        return
      }
      if (!profile.school_id) {
        await client.auth.signOut()
        if (active) {
          clearSessionState()
          setAuthReady(true)
        }
        return
      }
      const { data: rosterRecord } = await client.from('LQ_student_roster').select('school_id, last_name, first_names, is_active').eq('school_id', profile.school_id).maybeSingle()
      if (!active) return
      if (!rosterRecord || rosterRecord.is_active === false) {
        await client.auth.signOut()
        if (active) {
          clearSessionState()
          setAuthReady(true)
        }
        return
      }
      const avatar = await signedAvatarUrl(profile.avatar_url)
      if (!active) return
      applyLogin('student', { schoolId: rosterRecord.school_id, lastName: rosterRecord.last_name, firstNames: rosterRecord.first_names, avatarPath: profile.avatar_url ?? undefined, avatar: avatar.url ?? undefined }, Boolean(profile.must_change_password))
      setAuthReady(true)
    }

    void restoreSession()
    const { data: authListener } = client.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT' && active) {
        clearSessionState()
        setAuthReady(true)
      }
    })
    return () => {
      active = false
      authListener.subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (role !== 'student' || !student || !isSupabaseConfigured) return
    let active = true
    loadStudentWorkspace(student.schoolId).then((workspace) => {
      if (!active) return
      setQuizzes(workspace.quizzes)
      setScores(workspace.scores)
      if (workspace.quizzes[0]) setSelectedQuizId(workspace.quizzes[0].id)
    }).catch((error: Error) => {
      if (active) {
        setQuizzes([])
        setScores([])
        notify({ tone: 'warning', title: 'Unable to load workspace', message: error.message })
      }
    })
    return () => { active = false }
  }, [role, student?.schoolId, notify])

  useEffect(() => {
    if (role !== 'admin' || !isSupabaseConfigured) return
    let active = true
    loadAdminQuizzes().then((loaded) => {
      if (active) setAdminQuizzes(loaded)
    }).catch((error: Error) => {
      if (active) notify({ tone: 'warning', title: 'Unable to load quizzes', message: error.message })
    })
    return () => { active = false }
  }, [role, notify])

  const refreshAdminQuizzes = async () => {
    try {
      setAdminQuizzes(await loadAdminQuizzes())
    } catch (error) {
      notify({ tone: 'warning', title: 'Unable to refresh quizzes', message: (error as Error).message })
    }
  }

  const refreshStudentWorkspace = async () => {
    if (!student) return
    try {
      const workspace = await loadStudentWorkspace(student.schoolId)
      setQuizzes(workspace.quizzes)
      setScores(workspace.scores)
    } catch (error) {
      notify({ tone: 'warning', title: 'Unable to refresh scores', message: (error as Error).message })
    }
  }

  const openQuiz = (quiz: Quiz) => {
    if (quiz.status === 'locked') {
      notify({ tone: 'info', title: 'This quiz is locked', message: 'Your administrator has not assigned this quiz yet.' })
      return
    }
    if (quiz.status === 'ready') {
      setPendingQuiz(quiz)
      return
    }
    setSelectedQuizId(quiz.id)
    setSelectedQuiz(quiz)
    setStudentView('quiz')
  }

  const confirmQuizStart = () => {
    if (!pendingQuiz) return
    setSelectedQuizId(pendingQuiz.id)
    setSelectedQuiz(pendingQuiz)
    setStudentView('quiz')
    setPendingQuiz(null)
  }

  const handleLogout = () => setShowLogoutConfirm(true)

  const confirmLogout = async () => {
    if (isLoggingOut) return
    setIsLoggingOut(true)
    const result = await signOut()
    setIsLoggingOut(false)
    if (result.error) {
      notify({ tone: 'warning', title: 'Could not sign out', message: result.error.message })
      return
    }
    setShowLogoutConfirm(false)
    clearSessionState()
    setAdminView('overview')
    setStudentView('dashboard')
    setSelectedQuiz(null)
    setPendingQuiz(null)
    navigateAuth('student')
  }

  if (!authReady) {
    return <><AuthLoadingScreen />{toast && <Toast toast={toast} onClose={() => notify(null)} />}</>
  }

  if (!role) {
    return <><AuthScreen route={authRoute} onNavigate={navigateAuth} onLogin={applyLogin} notify={notify} />{toast && <Toast toast={toast} onClose={() => notify(null)} />}</>
  }

  if (role === 'student' && student && mustChangePassword) {
    return <><PasswordChangePage student={student} onComplete={() => setMustChangePassword(false)} onLogout={handleLogout} notify={notify} />{toast && <Toast toast={toast} onClose={() => notify(null)} />}{showLogoutConfirm && <ConfirmModal title="Sign out of LateQuiz?" message="Your current session will be closed on this device." confirmLabel={isLoggingOut ? 'Signing out...' : 'Sign out'} onCancel={() => setShowLogoutConfirm(false)} onConfirm={() => void confirmLogout()} />}</>
  }

  return <>
    {role === 'student' && student ? <StudentApp student={student} view={studentView} quiz={selectedQuiz ?? quizzes.find((item) => item.id === selectedQuizId) ?? null} quizzes={quizzes} scores={scores} onNavigate={setStudentView} onOpenQuiz={openQuiz} onRefreshWorkspace={refreshStudentWorkspace} onStudentUpdate={setStudent} onLogout={handleLogout} notify={notify} /> : <AdminApp view={adminView} quizzes={adminQuizzes} builderQuiz={adminQuizzes.find((item) => item.id === builderQuizId) ?? null} isBuilderNew={isBuilderNew} onNavigate={setAdminView} onStartBuilder={(isNew, quiz) => { setIsBuilderNew(isNew); setBuilderQuizId(quiz?.id ?? null); setAdminView('builder') }} onRefreshQuizzes={refreshAdminQuizzes} onLogout={handleLogout} notify={notify} />}
    {pendingQuiz && <ConfirmModal title="Start this quiz?" message={`${pendingQuiz.title} contains ${pendingQuiz.questions} question${pendingQuiz.questions === 1 ? '' : 's'} and allows ${pendingQuiz.durationMinutes} minutes. Your attempt timer starts when you continue.`} confirmLabel="Take quiz" onCancel={() => setPendingQuiz(null)} onConfirm={confirmQuizStart} />}
    {showLogoutConfirm && <ConfirmModal title="Sign out of LateQuiz?" message="Your current session will be closed on this device." confirmLabel={isLoggingOut ? 'Signing out...' : 'Sign out'} onCancel={() => setShowLogoutConfirm(false)} onConfirm={() => void confirmLogout()} />}
    {toast && <Toast toast={toast} onClose={() => notify(null)} />}
  </>
}

function LegacyAuthScreen({ route, onNavigate, onLogin, notify }: { route: AuthRoute; onNavigate: (route: AuthRoute) => void; onLogin: (role: Role, student?: Student, mustChangePassword?: boolean) => void; notify: (toast: ToastMessage) => void }) {
  const isAdmin = route === 'admin'
  const [identity, setIdentity] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isForgot, setIsForgot] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!identity.trim() || !password.trim()) {
      notify({ tone: 'warning', title: 'Complete the fields', message: isAdmin ? 'Enter your admin username and password.' : 'Enter your school ID and password.' })
      return
    }
    setIsLoading(true)
    const result = isAdmin ? await signInWithAdminUsername(identity, password) : await signInWithSchoolId(identity, password)
    if (result.error || !result.data?.user || !supabase) {
      notify({ tone: 'warning', title: 'Login failed', message: result.error?.message ?? 'The account is not available.' })
      setIsLoading(false)
      return
    }

    const { data: profile, error: profileError } = await supabase.from('LQ_profiles').select('role, school_id, must_change_password').eq('id', result.data.user.id).maybeSingle()
    if (profileError || !profile) {
      await signOut()
      notify({ tone: 'warning', title: 'Profile setup incomplete', message: 'Your account does not have a LateQuiz profile yet.' })
      setIsLoading(false)
      return
    }
    if ((isAdmin && profile.role !== 'admin') || (!isAdmin && profile.role === 'admin')) {
      await signOut()
      notify({ tone: 'warning', title: 'Wrong login portal', message: isAdmin ? 'Use the student login page for student accounts.' : 'Use the admin login page for administrator accounts.' })
      setIsLoading(false)
      return
    }

    let resolvedStudent: Student | undefined
    if (!isAdmin && profile.school_id) {
      const { data: rosterRecord } = await supabase.from('LQ_student_roster').select('school_id, last_name, first_names, is_active').eq('school_id', profile.school_id).maybeSingle()
      if (!rosterRecord || rosterRecord.is_active === false) {
        await signOut()
        notify({ tone: 'warning', title: 'Account unavailable', message: 'This student account is not active.' })
        setIsLoading(false)
        return
      }
      resolvedStudent = { schoolId: rosterRecord.school_id, lastName: rosterRecord.last_name, firstNames: rosterRecord.first_names }
    }
    onLogin(isAdmin ? 'admin' : 'student', resolvedStudent, Boolean(profile.must_change_password))
    notify({ tone: 'success', title: isAdmin ? 'Welcome to the admin workspace' : 'Welcome back', message: 'Your LateQuiz workspace is ready.' })
    setIsLoading(false)
  }

  const submitResetRequest = async (event: FormEvent) => {
    event.preventDefault()
    if (!identity.trim()) {
      notify({ tone: 'warning', title: 'Enter your school ID', message: 'Your administrator needs it to identify the account.' })
      return
    }
    setIsLoading(true)
    const result = await requestPasswordReset(identity)
    setIsLoading(false)
    if (result.error) {
      notify({ tone: 'warning', title: 'Request could not be sent', message: result.error.message })
      return
    }
    notify({ tone: 'success', title: 'Request sent', message: 'Your administrator has been notified.' })
    setIsForgot(false)
  }

  return <main className={`auth-page ${isAdmin ? 'auth-page-admin' : ''}`}>
    <section className="auth-visual">
      <div className="brand brand-on-dark"><span className="brand-mark"><GraduationCap size={21} /></span><span>LateQuiz</span></div>
      <div className="auth-visual-copy"><span className="eyebrow eyebrow-light">{isAdmin ? 'A clear command center' : 'A softer way back on track'}</span><h1>{isAdmin ? <>Keep every<br /><em>quiz moving.</em></> : <>One late quiz<br /><em>at a time.</em></>}</h1><p>{isAdmin ? 'Manage students, publish assessments, and give every submission the attention it deserves.' : 'Pick up where you left off, see exactly what to improve, and keep your term moving forward.'}</p></div>
      <div className="auth-quote"><Sparkles size={18} /><span>{isAdmin ? 'Simple tools for focused review.' : 'Built for progress, not pressure.'}</span></div>
      <div className="auth-visual-decoration"><div className="floating-note note-one"><Check size={15} /><span>{isAdmin ? 'Publish with confidence' : 'Small steps count'}</span></div><div className="floating-note note-two"><Target size={15} /><span>{isAdmin ? 'Students stay on track' : '75% goal in sight'}</span></div><div className="visual-ring ring-one" /><div className="visual-ring ring-two" /></div>
    </section>
    <section className="auth-panel"><div className="auth-panel-inner">
      <div className="mobile-brand brand"><span className="brand-mark"><GraduationCap size={21} /></span><span>LateQuiz</span></div>
      <div className="auth-heading"><span className="eyebrow">{isAdmin ? 'Administrator access' : 'Student portal'}</span><h2>{isForgot ? 'Request a password reset' : isAdmin ? 'Admin workspace' : 'Sign in to continue'}</h2><p>{isForgot ? 'Enter your school ID and your administrator will receive a reset request.' : isAdmin ? 'Review submissions, manage assignments, and keep students moving.' : 'Your school ID is your key to every assigned quiz.'}</p></div>
      {isForgot ? <form className="reset-card" onSubmit={submitResetRequest}><div className="reset-icon"><ShieldCheck size={22} /></div><h3>Ask your administrator</h3><p>Your account will be reset to the default password after your administrator approves the request.</p><label className="field-label" htmlFor="reset-school-id">School ID</label><div className="input-wrap"><UserRound size={18} /><input id="reset-school-id" value={identity} onChange={(event) => setIdentity(event.target.value)} placeholder="e.g. 24-00392" /></div><button className="button button-primary button-full" disabled={isLoading} type="submit">{isLoading ? 'Sending...' : 'Send reset request'} <Send size={15} /></button><button className="button button-secondary button-full" type="button" onClick={() => setIsForgot(false)}>Back to login</button></form> : <form className="auth-form" onSubmit={submit}>
        <label className="field-label" htmlFor="identity">{isAdmin ? 'Admin username' : 'School ID'}</label><div className="input-wrap"><UserRound size={18} /><input id="identity" value={identity} onChange={(event) => setIdentity(event.target.value)} placeholder={isAdmin ? 'Enter admin username' : 'e.g. 24-00392'} autoComplete="username" /></div>
        <div className="field-label-row"><label className="field-label" htmlFor="password">Password</label>{!isAdmin && <button type="button" className="text-button" onClick={() => setIsForgot(true)}>Forgot password?</button>}</div><div className="input-wrap"><LockIcon /><input id="password" value={password} onChange={(event) => setPassword(event.target.value)} type={showPassword ? 'text' : 'password'} placeholder="Enter your password" autoComplete="current-password" /><button type="button" className="input-action" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div>
        {!isAdmin && <p className="auth-hint">New or reset student accounts start with the default password provided by your administrator.</p>}
        <button className="button button-primary button-full button-large" disabled={isLoading} type="submit">{isLoading ? 'Checking...' : isAdmin ? 'Enter admin workspace' : 'Continue'} <ArrowRight size={17} /></button>
      </form>}
      <div className="auth-route-switch">{isAdmin ? <><span>Student account?</span><button className="text-button" onClick={() => onNavigate('student')}>Go to student login</button></> : <><span>Are you an administrator?</span><button className="button button-secondary" onClick={() => onNavigate('admin')}><ShieldCheck size={14} /> Admin login</button></>}</div>
      <p className="auth-footer">Need help? Contact your LateQuiz administrator.</p>
    </div></section>
  </main>
}

function LockIcon() {
  return <LockKeyhole size={18} />
}

function LegacyPasswordChangePage({ student, onComplete, onLogout, notify }: { student: Student; onComplete: () => void; onLogout: () => void; notify: (toast: ToastMessage) => void }) {
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (password.length < 8) return notify({ tone: 'warning', title: 'Use a stronger password', message: 'Your password must contain at least 8 characters.' })
    if (password === DEFAULT_STUDENT_PASSWORD) return notify({ tone: 'warning', title: 'Choose a new password', message: 'The default password cannot be reused.' })
    if (password !== confirmation) return notify({ tone: 'warning', title: 'Passwords do not match' })
    setIsSaving(true)
    const result = await changePassword(password)
    setIsSaving(false)
    if (result.error) return notify({ tone: 'warning', title: 'Password could not be changed', message: result.error.message })
    notify({ tone: 'success', title: 'Password updated', message: 'Your account is ready.' })
    onComplete()
  }
  return <main className="password-gate"><section className="password-gate-card"><div className="brand"><span className="brand-mark"><GraduationCap size={21} /></span><span>LateQuiz</span></div><div className="reset-icon"><ShieldCheck size={22} /></div><span className="eyebrow eyebrow-accent">First sign-in</span><h1>Choose your private password.</h1><p>Welcome, {displayName(student).split(' ')[0]}. For your protection, change the default password before entering your quizzes.</p><form className="auth-form" onSubmit={submit}><label className="field-label" htmlFor="new-password">New password</label><input className="form-input" id="new-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" /><label className="field-label" htmlFor="confirm-password">Confirm new password</label><input className="form-input" id="confirm-password" type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password" /><button className="button button-primary button-full" disabled={isSaving} type="submit">{isSaving ? 'Saving...' : 'Save password'} <ArrowRight size={16} /></button></form><button className="text-button" onClick={onLogout}>Sign out</button></section></main>
}

function LegacyStudentApp({ student, view, quiz, quizzes, scores, onNavigate, onOpenQuiz, onRefreshWorkspace, onLogout, notify }: { student: Student; view: StudentView; quiz: Quiz | null; quizzes: Quiz[]; scores: ScoreRecord[]; onNavigate: (view: StudentView) => void; onOpenQuiz: (quiz: Quiz) => void; onRefreshWorkspace: () => Promise<void>; onLogout: () => void; notify: (toast: ToastMessage) => void }) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const title = view === 'dashboard' ? 'Your recovery plan' : view === 'quiz' ? quiz?.title ?? 'Quiz workspace' : view === 'scores' ? 'Your scores' : 'Account settings'
  const eyebrow = view === 'dashboard' ? 'Student workspace' : view === 'quiz' ? quiz?.subject ?? DEFAULT_SUBJECT : view === 'scores' ? 'Progress history' : 'Personal settings'
  return <div className="app-shell"><Sidebar role="student" active={view} student={student} mobileOpen={mobileOpen} onClose={() => setMobileOpen(false)} onNavigate={(next) => onNavigate(next as StudentView)} onLogout={onLogout} /><div className="app-main"><header className="topbar"><button className="mobile-menu-button" onClick={() => setMobileOpen((value) => !value)} aria-label="Toggle navigation">{mobileOpen ? <X size={21} /> : <Menu size={21} />}</button><div className="topbar-heading"><span>{eyebrow}</span><h1>{title}</h1></div><div className="topbar-actions"><button className="icon-button topbar-help" onClick={() => notify({ tone: 'info', title: 'Need help?', message: 'Contact your LateQuiz administrator.' })} aria-label="Help"><HelpCircle size={19} /></button><button className="avatar avatar-small" aria-label="Open account" onClick={() => onNavigate('account')}>{initials(student)}</button></div></header><main className="page-content">{view === 'dashboard' && <StudentDashboard student={student} quizzes={quizzes} scores={scores} onOpenQuiz={onOpenQuiz} onNavigate={onNavigate} />}{view === 'quiz' && quiz && <StudentQuiz student={student} schoolId={student.schoolId} quiz={quiz} onExit={() => onNavigate('dashboard')} onRefreshWorkspace={onRefreshWorkspace} notify={notify} />}{view === 'scores' && <StudentScoresPage quizzes={quizzes} scores={scores} onOpenQuiz={onOpenQuiz} />}{view === 'account' && <StudentAccount student={student} notify={notify} />}</main></div></div>
}

function LegacyAdminApp({ view, quizzes, builderQuiz, isBuilderNew, onNavigate, onStartBuilder, onRefreshQuizzes, onLogout, notify }: { view: AdminView; quizzes: Quiz[]; builderQuiz: Quiz | null; isBuilderNew: boolean; onNavigate: (view: AdminView) => void; onStartBuilder: (isNew: boolean, quiz?: Quiz) => void; onRefreshQuizzes: () => Promise<void>; onLogout: () => void; notify: (toast: ToastMessage) => void }) {
  const now = useCurrentTime()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [focusStudentId, setFocusStudentId] = useState<string | null>(null)

  const refreshNotifications = async () => {
    try {
      setNotifications(await loadAdminNotifications())
    } catch (error) {
      notify({ tone: 'warning', title: 'Notifications unavailable', message: (error as Error).message })
    }
  }
  useEffect(() => {
    void refreshNotifications()
    const timer = window.setInterval(() => void refreshNotifications(), 30000)
    return () => window.clearInterval(timer)
  }, [])

  const handleNotification = async (notification: Notification) => {
    await markNotificationRead(notification.id)
    setNotifications((items) => items.map((item) => item.id === notification.id ? { ...item, readAt: new Date().toISOString() } : item))
    setFocusStudentId(notification.metadata?.school_id ?? null)
    onNavigate('students')
  }

  const title = view === 'overview' ? `${currentGreeting(now)}, admin` : view === 'quizzes' ? 'Manage quizzes' : view === 'builder' ? (isBuilderNew ? 'Create a new quiz' : 'Edit quiz') : view === 'submissions' ? 'Student submissions' : 'Manage students'
  const eyebrow = view === 'overview' ? 'Admin workspace' : view === 'quizzes' ? 'Assessment library' : view === 'builder' ? 'Quiz studio' : view === 'submissions' ? 'Review queue' : 'Roster and access'
  const unread = notifications.filter((item) => !item.readAt).length
  return <div className="app-shell admin-shell"><Sidebar role="admin" active={view} mobileOpen={mobileOpen} onClose={() => setMobileOpen(false)} onNavigate={(next) => onNavigate(next as AdminView)} onLogout={onLogout} /><div className="app-main"><header className="topbar"><button className="mobile-menu-button" onClick={() => setMobileOpen((value) => !value)} aria-label="Toggle navigation">{mobileOpen ? <X size={21} /> : <Menu size={21} />}</button><div className="topbar-heading"><span>{eyebrow}</span><h1>{title}</h1></div><div className="topbar-actions"><NotificationCenter notifications={notifications} unread={unread} onOpen={handleNotification} /><div className="admin-avatar">A</div></div></header><main className="page-content">{view === 'overview' && <AdminOverviewPage quizzes={quizzes} onNavigate={onNavigate} />}{view === 'quizzes' && <AdminQuizzes quizzes={quizzes} onStartBuilder={onStartBuilder} onRefresh={onRefreshQuizzes} notify={notify} />}{view === 'builder' && <AdminBuilderWorkspace key={builderQuiz?.id ?? 'new'} isNew={isBuilderNew} quiz={builderQuiz} onNavigate={onNavigate} onSaved={async () => { await onRefreshQuizzes(); onNavigate('quizzes') }} notify={notify} />}{view === 'submissions' && <AdminSubmissions />}{view === 'students' && <AdminStudentsPage focusStudentId={focusStudentId} notify={notify} />}</main></div></div>
}

function LegacySidebar({ role, active, onNavigate, onLogout, student, mobileOpen, onClose }: { role: Role; active: string; onNavigate: (view: string) => void; onLogout: () => void; student?: Student; mobileOpen: boolean; onClose: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const items = role === 'student' ? [{ id: 'dashboard', label: 'Overview', icon: Home }, { id: 'scores', label: 'Score history', icon: BarChart3 }, { id: 'account', label: 'My account', icon: UserRound }] : [{ id: 'overview', label: 'Overview', icon: LayoutDashboard }, { id: 'quizzes', label: 'Quiz library', icon: FolderKanban }, { id: 'submissions', label: 'Submissions', icon: ClipboardCheck }, { id: 'students', label: 'Students', icon: UsersRound }]
  return <><>{mobileOpen && <button className="sidebar-backdrop" onClick={onClose} aria-label="Close navigation" />}</><aside className={`sidebar ${role === 'admin' ? 'sidebar-admin' : ''} ${mobileOpen ? 'sidebar-open' : ''}`}><div className="sidebar-top"><div className="brand"><span className="brand-mark"><GraduationCap size={21} /></span><span>LateQuiz</span></div><span className="sidebar-role">{role === 'admin' ? 'ADMIN CONSOLE' : 'STUDENT PORTAL'}</span><nav className="side-nav"><span className="nav-section-label">Workspace</span>{items.map((item) => { const Icon = item.icon; return <button key={item.id} className={`side-nav-item ${active === item.id ? 'active' : ''}`} onClick={() => { onNavigate(item.id); onClose() }}><Icon size={18} /><span>{item.label}</span></button> })}</nav></div><div className="sidebar-bottom"><div className="sidebar-tip"><Sparkles size={17} /><div><strong>{role === 'student' ? 'You are doing great.' : 'Keep the workspace clear.'}</strong><span>{role === 'student' ? 'One focused session is enough for today.' : 'Create and publish one focused assessment at a time.'}</span></div></div><div className="sidebar-profile">{student ? <><span className="avatar avatar-small">{initials(student)}</span><div><strong>{displayName(student)}</strong><span>{student.schoolId}</span></div></> : <><span className="admin-avatar admin-avatar-small">A</span><div><strong>Administrator</strong><span>Full access</span></div></>}<button className="icon-button sidebar-more" aria-label="Account options" onClick={() => setMenuOpen((value) => !value)}><MoreHorizontal size={18} /></button>{menuOpen && <div className="menu-popover sidebar-popover"><button onClick={() => { onNavigate(role === 'student' ? 'account' : 'students'); setMenuOpen(false) }}><UserRound size={14} /> {role === 'student' ? 'Account settings' : 'Manage students'}</button><button onClick={() => { setMenuOpen(false); onLogout() }}><LogOut size={14} /> Sign out</button></div>}</div><button className="logout-button" onClick={onLogout}><LogOut size={17} /> Sign out</button></div></aside></>
}

function LegacyStudentDashboard({ student, quizzes, scores, onOpenQuiz, onNavigate }: { student: Student; quizzes: Quiz[]; scores: ScoreRecord[]; onOpenQuiz: (quiz: Quiz) => void; onNavigate: (view: StudentView) => void }) {
  const now = useCurrentTime()
  const assigned = quizzes.filter((quiz) => quiz.status !== 'locked')
  const completed = assigned.filter((quiz) => quiz.status === 'completed').length
  const finalScores = scores.filter((score) => score.status !== 'reviewing')
  const average = finalScores.length ? Math.round(finalScores.reduce((sum, score) => sum + score.score, 0) / finalScores.length) : 0
  const activeQuiz = assigned.find((quiz) => quiz.status === 'ready') ?? assigned[0]
  const latestScore = scores[0]
  return <div className="content-stack"><section className="welcome-row"><div><div className="eyebrow eyebrow-accent"><Sparkles size={14} /> {currentDateLabel(now)}</div><h2>{currentGreeting(now)}, {displayName(student).split(' ')[0]}.</h2><p>Let&apos;s make a little progress toward finishing strong.</p></div><div className="term-pill"><span className="status-dot status-dot-green" /> Term recovery plan <ChevronDown size={15} /></div></section><section className="student-stat-grid"><StatCard icon={<Clock3 size={19} />} label="Assigned quizzes" value={String(assigned.length)} detail={assigned.length ? `${assigned.length - completed} remaining` : 'Nothing assigned yet'} tone="lavender" /><StatCard icon={<BarChart3 size={19} />} label="Average score" value={finalScores.length ? `${average}%` : '--'} detail={finalScores.length ? `${finalScores.length} finalized result${finalScores.length === 1 ? '' : 's'}` : 'No finalized results'} tone="mint" /><StatCard icon={<CheckCheck size={19} />} label="Completed" value={`${completed} / ${assigned.length}`} detail={assigned.length ? `${Math.max(assigned.length - completed, 0)} remaining` : 'No assigned quizzes'} tone="peach" /></section>{activeQuiz ? <section className="dashboard-grid"><div className="main-column"><div className="section-heading"><div><span className="eyebrow">Your next step</span><h3>Keep your momentum</h3></div><button className="text-button with-icon" onClick={() => onNavigate('scores')}>View score history <ArrowUpRight size={15} /></button></div><article className="featured-quiz-card"><div className="featured-card-top"><div className="subject-badge"><Code2 size={15} /> {activeQuiz.subject}</div><span className="quiz-time"><Clock3 size={14} /> {activeQuiz.durationMinutes} min</span></div><div className="featured-card-body"><div><h3>{activeQuiz.title}</h3><p>{activeQuiz.description || 'Your next assigned recovery assessment.'}</p></div><span className="featured-icon"><Code2 size={31} /></span></div><div className="featured-card-bottom"><div className="quiz-progress-copy"><span><strong>{activeQuiz.progress ?? 0}%</strong> completed</span><span>{activeQuiz.answeredCount ?? 0} of {activeQuiz.questions} answered</span></div><div className="progress-track progress-track-light"><span style={{ width: `${activeQuiz.progress ?? 0}%` }} /></div><button className="button button-white" onClick={() => onOpenQuiz(activeQuiz)}>Continue quiz <ArrowRight size={16} /></button></div></article><div className="section-heading section-heading-spaced"><div><span className="eyebrow">Your quizzes</span><h3>All assessments</h3></div><span className="muted-label">{quizzes.length} visible</span></div><div className="quiz-list">{quizzes.map((quiz) => <StudentQuizCard key={quiz.id} quiz={quiz} onOpen={onOpenQuiz} />)}</div></div><aside className="dashboard-aside"><section className="aside-card motivation-card"><div className="motivation-spark"><Sparkles size={17} /></div><span className="eyebrow">A note for you</span><h3>Progress is not always loud.</h3><p>Showing up for one question today is still moving forward.</p><span className="aside-footnote">Your dashboard updates from saved attempts.</span></section>{latestScore && <section className="aside-card score-card"><div className="aside-card-heading"><div><span className="eyebrow">Latest result</span><h3>{latestScore.title}</h3></div><span className="score-circle">{latestScore.score}</span></div><div className="score-line"><span>{latestScore.status === 'passed' ? 'Passed' : latestScore.status === 'reviewing' ? 'Under review' : 'Needs retake'}</span><span>{latestScore.date}</span></div><div className="score-progress"><span style={{ width: `${latestScore.score}%` }} /></div><button className="text-button with-icon" onClick={() => onNavigate('scores')}>See result details <ChevronRight size={15} /></button></section>}</aside></section> : <section className="empty-state page-empty-state"><span className="empty-state-icon"><FolderKanban size={22} /></span><strong>{quizzes.length ? 'No assigned quizzes yet' : 'No quizzes available'}</strong><span>Your administrator will publish and assign assessments here.</span><button className="button button-secondary" onClick={() => onNavigate('scores')}>View score history</button></section>}</div>
}

function StudentQuizCard({ quiz, onOpen }: { quiz: Quiz; onOpen: (quiz: Quiz) => void }) {
  const locked = quiz.status === 'locked'
  const complete = quiz.status === 'completed'
  const SubjectIcon = quiz.subject === DEFAULT_SUBJECT ? BookOpen : quiz.subject.includes('Web') ? Layers3 : Code2
  return <article className={`quiz-card ${locked ? 'quiz-card-locked' : ''}`}><div className="quiz-card-icon"><SubjectIcon size={19} /></div><div className="quiz-card-content"><div className="quiz-card-meta"><span>{quiz.subject}</span>{complete ? <StatusBadge tone="success">Completed</StatusBadge> : locked ? <StatusBadge tone="neutral" icon={<LockKeyhole size={11} />}>Not assigned</StatusBadge> : <StatusBadge tone="warning">In progress</StatusBadge>}</div><h3>{quiz.title}</h3><div className="quiz-card-details"><span><ListChecks size={14} /> {quiz.questions} questions</span><span><Clock3 size={14} /> {quiz.durationMinutes} min</span></div></div><button className={`icon-button card-arrow ${locked ? 'is-locked' : ''}`} onClick={() => onOpen(quiz)} aria-label={locked ? 'Quiz not assigned' : `Open ${quiz.title}`}>{locked ? <LockKeyhole size={17} /> : <ArrowUpRight size={18} />}</button>{complete && <div className="card-score"><strong>{quiz.score}%</strong><span>score</span></div>}</article>
}

function LegacyStudentQuiz({ student, schoolId, quiz, onExit, onRefreshWorkspace, notify }: { student: Student; schoolId: string; quiz: Quiz; onExit: () => void; onRefreshWorkspace: () => Promise<void>; notify: (toast: ToastMessage) => void }) {
  const questions = quiz.questionsList ?? []
  const [currentIndex, setCurrentIndex] = useState(0)
  const [isReview, setIsReview] = useState(false)
  const [isSubmitted, setIsSubmitted] = useState(false)
  const [attemptId, setAttemptId] = useState<string | null>(null)
  const [expiresAt, setExpiresAt] = useState<string | null>(quiz.expiresAt ?? null)
  const [secondsLeft, setSecondsLeft] = useState(() => quiz.expiresAt ? Math.max(0, Math.ceil((new Date(quiz.expiresAt).getTime() - Date.now()) / 1000)) : quiz.durationMinutes * 60)
  const [answers, setAnswers] = useState<Record<string, string>>(() => Object.fromEntries(questions.map((question) => [question.id, question.response ?? ''])))
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submissionResult, setSubmissionResult] = useState<AttemptSubmissionResult | null>(null)
  const currentQuestion = questions[currentIndex]
  const answeredCount = Object.values(answers).filter(Boolean).length
  const progress = questions.length ? Math.round((answeredCount / questions.length) * 100) : 0

  useEffect(() => {
    if (quiz.status !== 'ready') return
    let active = true
    startAttempt(quiz.id, schoolId).then((result) => {
      if (!active) return
      if (result.error) return notify({ tone: 'warning', title: 'Unable to start attempt', message: result.error.message })
      setAttemptId(result.attemptId)
      if (result.expiresAt) {
        setExpiresAt(result.expiresAt)
        setSecondsLeft(Math.max(0, Math.ceil((new Date(result.expiresAt).getTime() - Date.now()) / 1000)))
      }
    }).catch((error: Error) => { if (active) notify({ tone: 'warning', title: 'Unable to start attempt', message: error.message }) })
    return () => { active = false }
  }, [quiz.id, quiz.status, schoolId, notify])

  useEffect(() => {
    if (!attemptId || isSubmitted) return
    const timeout = window.setTimeout(async () => {
      const result = await saveAttemptAnswers(attemptId, questions, answers)
      if (result.error) notify({ tone: 'warning', title: 'Answer autosave failed', message: result.error.message })
    }, 550)
    return () => window.clearTimeout(timeout)
  }, [answers, attemptId, isSubmitted, notify, questions])

  useEffect(() => {
    if (!expiresAt || isSubmitted) return
    const update = () => setSecondsLeft(Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000)))
    update()
    const timer = window.setInterval(update, 1000)
    return () => window.clearInterval(timer)
  }, [expiresAt, isSubmitted])

  const finishQuiz = async () => {
    if (isSubmitting) return
    if (!attemptId) return notify({ tone: 'warning', title: 'Attempt is not ready', message: 'Wait for the quiz attempt to connect before submitting.' })
    setIsSubmitting(true)
    const saveResult = await saveAttemptAnswers(attemptId, questions, answers)
    if (saveResult.error) {
      notify({ tone: 'warning', title: 'Could not save all answers', message: saveResult.error.message })
      setIsSubmitting(false)
      return
    }
    const submitResult = await submitAttempt(attemptId)
    if (submitResult.error) {
      notify({ tone: 'warning', title: 'Could not submit quiz', message: submitResult.error.message })
      setIsSubmitting(false)
      return
    }
    setSubmissionResult(submitResult.data ?? null)
    setIsSubmitted(true)
    setIsSubmitting(false)
    void onRefreshWorkspace()
  }

  useEffect(() => {
    if (secondsLeft === 0 && !isSubmitted && attemptId) {
      void finishQuiz()
      notify({ tone: 'warning', title: 'Time is up', message: 'Your saved answers were submitted automatically.' })
    }
  }, [secondsLeft, isSubmitted, attemptId])

  if (quiz.status === 'completed' || quiz.status === 'in-review') return <section className="quiz-result-page"><button className="back-link" onClick={onExit}><ArrowLeft size={16} /> Back to dashboard</button><div className="result-card"><div className="result-burst"><CheckCircle2 size={30} /></div><span className="eyebrow eyebrow-accent">{quiz.status === 'completed' ? 'Completed quiz' : 'Awaiting review'}</span><h2>{quiz.status === 'completed' ? `You scored ${quiz.score ?? 0}%.` : 'Your answers are under review.'}</h2><p>This quiz is read-only because the attempt has already been submitted.</p><button className="button button-primary" onClick={onExit}>Return to dashboard <ArrowRight size={16} /></button></div></section>
  if (!currentQuestion) return <section className="quiz-result-page"><button className="back-link" onClick={onExit}><ArrowLeft size={16} /> Back to dashboard</button><div className="result-card"><div className="result-burst"><BookOpen size={28} /></div><h2>This quiz has no questions yet.</h2><p>Ask your administrator to finish the quiz before starting it.</p></div></section>
  if (isSubmitted) return <section className="quiz-result-page"><button className="back-link" onClick={onExit}><ArrowLeft size={16} /> Back to dashboard</button><div className="result-card"><div className="result-burst"><CheckCircle2 size={30} /></div><span className="eyebrow eyebrow-accent">Submission received</span><h2>Nice work, {displayName(student).split(' ')[0]}.</h2><p>Your answers are saved. Written and uploaded items remain available for administrator review.</p><div className="result-summary"><div><span>Auto-graded score</span><strong>{submissionResult ? `${submissionResult.auto_score}%` : '--'}</strong></div><div><span>Manual review</span><strong>{submissionResult?.manual_items ? `${submissionResult.manual_items} pending` : 'None pending'}</strong></div><div><span>Submitted</span><strong>{submissionResult?.expired ? 'Time expired' : 'Just now'}</strong></div></div><button className="button button-primary" onClick={onExit}>Return to dashboard <ArrowRight size={16} /></button></div></section>

  const formatTime = `${Math.floor(secondsLeft / 60).toString().padStart(2, '0')}:${(secondsLeft % 60).toString().padStart(2, '0')}`
  const setAnswer = (value: string) => setAnswers((current) => ({ ...current, [currentQuestion.id]: value }))
  return <div className="quiz-runner"><div className="quiz-runner-top"><button className="back-link" onClick={onExit}><ArrowLeft size={16} /> Exit quiz</button><div className={`timer-pill ${secondsLeft < 300 ? 'timer-warning' : ''}`}><Clock3 size={16} /><span>{formatTime}</span><small>remaining</small></div></div><div className="quiz-runner-layout"><aside className="question-sidebar"><div className="question-sidebar-heading"><div><span className="eyebrow">Question map</span><strong>{answeredCount} of {questions.length} answered</strong></div><span className="question-percent">{progress}%</span></div><div className="progress-track"><span style={{ width: `${progress}%` }} /></div><div className="question-grid">{questions.map((question, index) => <button key={question.id} className={`${index === currentIndex ? 'current ' : ''}${answers[question.id] ? 'answered' : ''}`} onClick={() => { setCurrentIndex(index); setIsReview(false) }}>{index + 1}{answers[question.id] && <Check size={11} />}</button>)}</div></aside><section className="question-panel">{isReview ? <QuizReview answers={answers} questions={questions} onJump={(index) => { setCurrentIndex(index); setIsReview(false) }} onBack={() => setIsReview(false)} onSubmit={() => void finishQuiz()} /> : <><div className="question-panel-heading"><div><span className="question-number">Question {currentIndex + 1} <span>of {questions.length}</span></span><StatusBadge tone={currentQuestion.requiresReview ? 'purple' : 'blue'}>{currentQuestion.type === 'multiple-choice' ? 'Multiple choice' : currentQuestion.type === 'identification' ? 'Identification' : currentQuestion.type === 'essay' ? 'Essay' : 'File upload'}</StatusBadge></div><span className="question-points">{currentQuestion.points} pts</span></div><div className="question-copy"><h2>{currentQuestion.prompt}</h2><p>Answer carefully. Your progress saves automatically.</p></div><QuestionInput question={currentQuestion} value={answers[currentQuestion.id] ?? ''} onChange={setAnswer} /><div className="question-footer"><div className="question-nav-buttons"><button className="button button-secondary previous-button" disabled={currentIndex === 0} onClick={() => setCurrentIndex((index) => Math.max(0, index - 1))}><ArrowLeft size={15} /> Previous</button><button className="button button-secondary" disabled={currentIndex === questions.length - 1} onClick={() => setCurrentIndex((index) => Math.min(questions.length - 1, index + 1))}>Next <ArrowRight size={15} /></button></div><button className="button button-primary" onClick={() => setIsReview(true)}>Review answers <CheckCheck size={15} /></button></div></>}</section></div></div>
}

function QuestionInput({ question, value, onChange }: { question: Question; value: string; onChange: (value: string) => void }) {
  if (question.type === 'multiple-choice') return <div className="answer-options">{(question.options ?? []).map((option, index) => <button key={`${option}-${index}`} className={`answer-option ${value === option ? 'selected' : ''}`} onClick={() => onChange(option)}><span className="option-key">{String.fromCharCode(65 + index)}</span><span>{option}</span>{value === option && <CheckCircle2 className="option-check" size={19} />}</button>)}</div>
  if (question.type === 'upload') return <div className="upload-answer"><label className="upload-dropzone"><div className="upload-icon"><FileUp size={23} /></div><strong>Choose your file</strong><span>PDF, JPG, or PNG up to 10 MB</span><input type="file" accept=".pdf,.jpg,.jpeg,.png" onChange={(event) => onChange(event.target.files?.[0]?.name ?? '')} /></label>{value && <div className="uploaded-file"><span className="file-icon"><FileText size={17} /></span><div><strong>{value}</strong><span>Ready for submission</span></div><button className="icon-button" onClick={() => onChange('')} aria-label="Remove file"><X size={16} /></button></div>}</div>
  return <div className="text-answer"><textarea value={value} onChange={(event) => onChange(event.target.value)} placeholder={question.type === 'identification' ? 'Type your answer here...' : 'Write a clear and concise response...'} rows={question.type === 'essay' ? 7 : 3} /><span className="textarea-footnote">Answers are not case-sensitive.</span></div>
}

function LegacyQuizReview({ answers, questions, onJump, onBack, onSubmit }: { answers: Record<string, string>; questions: Question[]; onJump: (index: number) => void; onBack: () => void; onSubmit: () => void }) {
  const unanswered = questions.filter((question) => !answers[question.id]).length
  return <div className="review-panel"><div className="review-heading"><span className="eyebrow eyebrow-accent">Final check</span><h2>Review your answers</h2><p>Double-check your responses before submitting.</p></div>{unanswered > 0 && <div className="review-alert"><CircleAlert size={18} /><span><strong>{unanswered} unanswered.</strong> You can still go back.</span></div>}<div className="review-list">{questions.map((question, index) => <button key={question.id} className="review-row" onClick={() => onJump(index)}><span className={`review-number ${answers[question.id] ? 'answered' : ''}`}>{answers[question.id] ? <Check size={14} /> : index + 1}</span><span className="review-row-copy"><strong>Question {index + 1}</strong><span>{answers[question.id] || 'No answer yet'}</span></span><ChevronRight size={17} /></button>)}</div><div className="review-actions"><button className="button button-secondary" onClick={onBack}><ArrowLeft size={16} /> Keep answering</button><button className="button button-primary" onClick={onSubmit}>Submit quiz <Send size={15} /></button></div></div>
}

function LegacyStudentScoresPage({ quizzes, scores, onOpenQuiz }: { quizzes: Quiz[]; scores: ScoreRecord[]; onOpenQuiz: (quiz: Quiz) => void }) {
  const average = scores.length ? Math.round(scores.reduce((sum, score) => sum + score.score, 0) / scores.length) : 0
  const nextQuiz = quizzes.find((quiz) => quiz.status === 'ready')
  return <div className="content-stack"><section className="page-intro-row"><div><span className="eyebrow">Progress history</span><h2>A record of your effort.</h2><p>Every attempt is a useful signal. Keep building from here.</p></div><div className="score-summary-chip"><span className="score-summary-ring">{scores.length ? average : '--'}</span><div><strong>Current average</strong><span>{scores.length ? `Across ${scores.length} finalized results` : 'No finalized results yet'}</span></div></div></section><section className="score-overview-grid"><div className="score-overview-card"><div className="section-heading"><div><span className="eyebrow">Term performance</span><h3>{scores.length ? 'Your recorded scores' : 'Your first result starts here'}</h3></div></div><div className="score-chart"><div className="chart-y-labels"><span>100</span><span>75</span><span>50</span><span>25</span><span>0</span></div><div className="chart-area"><div className="chart-grid-lines"><i /><i /><i /><i /><i /></div><div className="chart-bars">{(scores.length ? scores.slice(-6).map((score) => score.score) : [0]).map((value, index) => <span key={index} className={index === (scores.length ? Math.min(scores.length, 6) - 1 : 0) ? 'bar-current' : ''} style={{ height: `${Math.max(value, 8)}%` }}><b>{value}</b></span>)}</div><div className="chart-x-labels"><span>Recent</span><span>Results</span></div></div></div></div><div className="score-overview-card goal-card"><div className="goal-icon"><Target size={20} /></div><span className="eyebrow">Your term goal</span><h3>Pass every recovery quiz</h3><p>{nextQuiz ? 'You have an assigned quiz ready for your next focused session.' : 'Your current recovery plan is complete or waiting for an assignment.'}</p><div className="goal-progress"><div><span>{scores.filter((score) => score.status === 'passed').length} passed</span><strong>{scores.length ? `${average}% avg` : '--'}</strong></div><div className="progress-track"><span style={{ width: `${Math.min(average, 100)}%` }} /></div></div>{nextQuiz && <button className="text-button with-icon" onClick={() => onOpenQuiz(nextQuiz)}>Continue next quiz <ArrowRight size={15} /></button>}</div></section><section className="table-card"><div className="table-card-heading"><div><span className="eyebrow">Recorded attempts</span><h3>Your score history</h3></div></div>{scores.length ? <div className="score-table"><div className="score-table-head"><span>Assessment</span><span>Date</span><span>Score</span><span>Status</span><span /></div>{scores.map((score) => <ScoreRow key={score.id} record={score} />)}</div> : <div className="empty-state"><BarChart3 size={24} /><strong>No results yet</strong><span>Completed quizzes will appear here.</span></div>}</section></div>
}

function ScoreRow({ record }: { record: ScoreRecord }) {
  return <div className="score-table-row"><div className="table-assessment"><span className="table-assessment-icon"><BookOpen size={16} /></span><div><strong>{record.title}</strong><span>{record.subject}</span></div></div><span className="table-date">{record.date}</span><div className="table-score"><strong>{record.score}%</strong><span>{record.earnedPoints !== undefined && record.possiblePoints !== undefined ? `${record.earnedPoints} / ${record.possiblePoints} pts` : `of ${record.total}`}</span></div><StatusBadge tone={record.status === 'passed' ? 'success' : record.status === 'reviewing' ? 'warning' : 'danger'}>{record.status === 'passed' ? 'Passed' : record.status === 'reviewing' ? 'Under review' : 'Needs retake'}</StatusBadge><span /></div>
}

function LegacyStudentAccount({ student, notify }: { student: Student; notify: (toast: ToastMessage) => void }) {
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (password.length < 8 || password !== confirmation) return notify({ tone: 'warning', title: 'Check your new password', message: 'Use at least 8 characters and make both fields match.' })
    setIsSaving(true)
    const result = await changePassword(password)
    setIsSaving(false)
    if (result.error) return notify({ tone: 'warning', title: 'Password could not be changed', message: result.error.message })
    setPassword('')
    setConfirmation('')
    notify({ tone: 'success', title: 'Password changed', message: 'Your account is protected with the new password.' })
  }
  return <div className="content-stack account-page"><section className="page-intro-row"><div><span className="eyebrow">Personal settings</span><h2>Your account, your way.</h2><p>Your name and school ID are managed by the administrator.</p></div><span className="account-secure"><ShieldCheck size={15} /> Account protected</span></section><div className="account-layout"><section className="form-card"><div className="form-card-heading"><div><span className="eyebrow">Profile details</span><h3>{displayName(student)}</h3></div><span className="avatar avatar-small">{initials(student)}</span></div><div className="settings-fields"><div><label className="field-label">School ID</label><div className="readonly-input"><ShieldCheck size={16} /> {student.schoolId}<span>Verified</span></div></div><div className="info-callout"><CircleAlert size={17} /><span>School ID and profile names are used for quiz assignments and are managed by your administrator.</span></div></div></section><section className="form-card security-card"><div className="form-card-heading"><div><span className="eyebrow">Security</span><h3>Change password</h3></div><LockKeyhole size={20} className="muted-icon" /></div><form className="settings-fields" onSubmit={save}><div><label className="field-label" htmlFor="account-password">New password</label><input className="form-input" id="account-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></div><div><label className="field-label" htmlFor="account-password-confirm">Confirm password</label><input className="form-input" id="account-password-confirm" type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></div><button className="button button-primary" disabled={isSaving} type="submit">{isSaving ? 'Saving...' : 'Update password'} <CheckCheck size={16} /></button></form></section></div></div>
}

function AdminOverviewPage({ quizzes, onNavigate }: { quizzes: Quiz[]; onNavigate: (view: AdminView) => void }) {
  const now = useCurrentTime()
  const [students, setStudents] = useState<Student[]>([])
  useEffect(() => { loadAdminRoster().then(setStudents).catch(() => setStudents([])) }, [])
  const published = quizzes.filter((quiz) => quiz.status === 'ready').length
  const drafts = quizzes.filter((quiz) => quiz.status === 'draft').length
  return <div className="content-stack"><section className="admin-welcome-row"><div><span className="eyebrow eyebrow-accent"><Sparkles size={14} /> {currentDateLabel(now)}</span><h2>{currentGreeting(now)}, admin.</h2><p>Build, publish, and assign focused assessments.</p></div><button className="button button-primary" onClick={() => onNavigate('builder')}><Plus size={17} /> Create quiz</button></section><section className="admin-stat-grid"><AdminStat icon={<UsersRound size={19} />} value={String(students.filter((student) => student.active !== false).length)} label="Active students" detail="Database roster" tone="blue" /><AdminStat icon={<ClipboardCheck size={19} />} value="--" label="Need review" detail="No review queue loaded" tone="peach" /><AdminStat icon={<FolderKanban size={19} />} value={String(published)} label="Published quizzes" detail={`${drafts} drafts`} tone="purple" /><AdminStat icon={<BarChart3 size={19} />} value="--" label="Average score" detail="No finalized attempts" tone="green" /></section><section className="admin-dashboard-grid"><div className="admin-main-column"><div className="section-heading"><div><span className="eyebrow">Quiz activity</span><h3>{quizzes.length ? 'Your quiz library is ready' : 'Start with your library'}</h3></div><button className="text-button with-icon" onClick={() => onNavigate('quizzes')}>View all quizzes <ArrowUpRight size={15} /></button></div><section className="submission-preview-card empty-state"><FolderKanban size={24} /><strong>{quizzes.length ? `${quizzes.length} quizzes in the library` : 'No quizzes yet'}</strong><span>Drafts stay private until you publish them.</span><button className="button button-secondary" onClick={() => onNavigate('quizzes')}>Open quiz library</button></section></div><aside className="admin-aside"><section className="aside-card motivation-card"><div className="motivation-spark"><Sparkles size={17} /></div><span className="eyebrow">Simple workflow</span><h3>Build, publish, assign.</h3><p>Create an assessment, publish it when ready, then assign it directly from its quiz card.</p></section></aside></section></div>
}

function LegacyAdminQuizzes({ quizzes, onStartBuilder, onRefresh, notify }: { quizzes: Quiz[]; onStartBuilder: (isNew: boolean, quiz?: Quiz) => void; onRefresh: () => Promise<void>; notify: (toast: ToastMessage) => void }) {
  const [filter, setFilter] = useState('All quizzes')
  const [search, setSearch] = useState('')
  const [assigningQuiz, setAssigningQuiz] = useState<Quiz | null>(null)
  const filters = ['All quizzes', 'Published', 'Drafts', 'Archived']
  const filtered = quizzes.filter((quiz) => {
    const matches = filter === 'All quizzes' || filter === 'Published' && quiz.status === 'ready' || filter === 'Drafts' && quiz.status === 'draft' || filter === 'Archived' && quiz.status === 'archived'
    return matches && `${quiz.title} ${quiz.subject} ${quiz.description}`.toLowerCase().includes(search.toLowerCase())
  })
  return <div className="content-stack"><section className="page-intro-row admin-page-intro"><div><span className="eyebrow">Assessment library</span><h2>All quizzes, one clear workspace.</h2><p>Create, review, publish, and assign recovery assessments from one place.</p></div><button className="button button-primary" onClick={() => onStartBuilder(true)}><Plus size={17} /> New quiz</button></section><div className="quiz-library-toolbar"><div className="filter-tabs">{filters.map((item) => <button key={item} className={filter === item ? 'active' : ''} onClick={() => setFilter(item)}>{item}<span>{item === 'All quizzes' ? quizzes.length : item === 'Published' ? quizzes.filter((quiz) => quiz.status === 'ready').length : item === 'Drafts' ? quizzes.filter((quiz) => quiz.status === 'draft').length : quizzes.filter((quiz) => quiz.status === 'archived').length}</span></button>)}</div><div className="search-wrap"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search quizzes" /></div></div>{filtered.length ? <div className="admin-quiz-grid">{filtered.map((quiz) => <AdminQuizCard key={quiz.id} quiz={quiz} onEdit={() => onStartBuilder(false, quiz)} onAssign={() => setAssigningQuiz(quiz)} onRefresh={onRefresh} notify={notify} />)}<button className="new-quiz-card" onClick={() => onStartBuilder(true)}><span><Plus size={21} /></span><strong>Create another quiz</strong><small>Start with a clean question set</small></button></div> : <section className="quiz-library-empty"><span className="empty-state-icon"><FolderKanban size={22} /></span><strong>{quizzes.length ? 'No quizzes match this filter' : 'No quizzes yet'}</strong><span>{quizzes.length ? 'Try another filter or search term.' : 'Create your first quiz to start building the library.'}</span><button className="button button-primary" onClick={() => onStartBuilder(true)}><Plus size={15} /> Create quiz</button></section>}{assigningQuiz && <AssignQuizModal quiz={assigningQuiz} onClose={() => setAssigningQuiz(null)} onSaved={async () => { await onRefresh(); setAssigningQuiz(null) }} notify={notify} />}</div>
}

function LegacyAdminQuizCard({ quiz, onEdit, onAssign, onRefresh, notify }: { quiz: Quiz; onEdit: () => void; onAssign: () => void; onRefresh: () => Promise<void>; notify: (toast: ToastMessage) => void }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const statusTone = quiz.status === 'ready' ? 'success' : quiz.status === 'draft' ? 'warning' : 'neutral'
  const statusLabel = quiz.status === 'ready' ? 'Published' : quiz.status === 'draft' ? 'Draft' : 'Archived'
  const changeStatus = async (status: 'draft' | 'published' | 'archived') => {
    const result = await setQuizStatus(quiz.id, status)
    if (result.error) notify({ tone: 'warning', title: 'Quiz status could not change', message: result.error.message })
    else { notify({ tone: 'success', title: status === 'published' ? 'Quiz published' : status === 'archived' ? 'Quiz archived' : 'Quiz moved to drafts' }); await onRefresh() }
    setMenuOpen(false)
  }
  return <article className="admin-quiz-card"><div className="admin-quiz-card-top"><div className={`admin-quiz-art ${quiz.subject === DEFAULT_SUBJECT ? 'art-blue' : 'art-purple'}`}><BookOpen size={22} /></div><div className="menu-anchor"><button className="icon-button" aria-label="More quiz actions" onClick={() => setMenuOpen((value) => !value)}><MoreHorizontal size={18} /></button>{menuOpen && <div className="menu-popover quiz-popover"><button onClick={onEdit}><Pencil size={14} /> Edit quiz</button><button onClick={onAssign}><UsersRound size={14} /> Assign students</button>{quiz.status === 'ready' ? <button onClick={() => void changeStatus('draft')}><FileText size={14} /> Move to drafts</button> : quiz.status === 'draft' ? <button onClick={() => void changeStatus('published')}><Send size={14} /> Publish quiz</button> : <button onClick={() => void changeStatus('draft')}><FolderKanban size={14} /> Restore draft</button>}</div>}</div></div><div className="admin-quiz-card-copy"><div className="quiz-card-meta"><span>{quiz.subject}</span><StatusBadge tone={statusTone}>{statusLabel}</StatusBadge></div><h3>{quiz.title}</h3><p>{quiz.description || 'No instructions added yet.'}</p></div><div className="admin-quiz-card-stats"><span><ListChecks size={14} /> {quiz.questions} questions</span><span><UsersRound size={14} /> {quiz.assignedCount ?? 0} assigned</span><span><Clock3 size={14} /> {quiz.durationMinutes} min</span></div><div className="admin-quiz-card-actions"><button className="button button-secondary" onClick={onEdit}><Pencil size={14} /> Edit quiz</button><button className="button button-primary" onClick={onAssign}><UsersRound size={14} /> Assign</button></div></article>
}

function LegacyAssignQuizModal({ quiz, onClose, onSaved, notify }: { quiz: Quiz; onClose: () => void; onSaved: () => Promise<void>; notify: (toast: ToastMessage) => void }) {
  const [students, setStudents] = useState<Student[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [attemptLimit, setAttemptLimit] = useState(1)
  const [isSaving, setIsSaving] = useState(false)
  useEffect(() => { loadAdminRoster().then(setStudents).catch((error: Error) => notify({ tone: 'warning', title: 'Students could not load', message: error.message })) }, [])
  const visible = students.filter((student) => `${student.schoolId} ${student.firstNames} ${student.lastName}`.toLowerCase().includes(search.toLowerCase()) && student.active !== false)
  const allSelected = visible.length > 0 && visible.every((student) => selected.includes(student.schoolId))
  const toggleAll = () => setSelected(allSelected ? selected.filter((id) => !visible.some((student) => student.schoolId === id)) : [...new Set([...selected, ...visible.map((student) => student.schoolId)])])
  const save = async () => {
    setIsSaving(true)
    const result = await assignQuiz(quiz.id, selected, attemptLimit)
    setIsSaving(false)
    if (result.error) return notify({ tone: 'warning', title: 'Assignment failed', message: result.error.message })
    notify({ tone: 'success', title: 'Quiz assigned', message: `${selected.length} student${selected.length === 1 ? '' : 's'} can now access this quiz when it is published.` })
    await onSaved()
  }
  return <div className="modal-overlay" onClick={onClose}><section className="assignment-modal" onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><span className="eyebrow eyebrow-accent">Assign quiz</span><h2>{quiz.title}</h2><p>Select students and set their attempt limit.</p></div><button className="icon-button" onClick={onClose} aria-label="Close assignment"><X size={18} /></button></div><div className="assignment-modal-toolbar"><div className="search-wrap"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search students" /></div><label className="attempt-select">Attempts<select value={attemptLimit} onChange={(event) => setAttemptLimit(Number(event.target.value))}><option value="1">1 attempt</option><option value="2">2 attempts</option><option value="3">3 attempts</option><option value="5">5 attempts</option></select></label></div><div className="assignment-select-all"><label className="table-check"><input type="checkbox" checked={allSelected} onChange={toggleAll} /><span className="custom-check"><Check size={12} /></span></label><span>Select all visible students</span><strong>{selected.length} selected</strong></div><div className="assignment-student-list">{visible.map((student) => <label className={`assignment-student-row ${selected.includes(student.schoolId) ? 'selected' : ''}`} key={student.schoolId}><span className="table-check"><input type="checkbox" checked={selected.includes(student.schoolId)} onChange={() => setSelected((items) => items.includes(student.schoolId) ? items.filter((id) => id !== student.schoolId) : [...items, student.schoolId])} /><span className="custom-check"><Check size={12} /></span></span><span className="avatar avatar-tiny avatar-mint">{initials(student)}</span><span><strong>{displayName(student)}</strong><small>{student.schoolId}</small></span><span className="assignment-count">{student.assignmentCount ?? 0} assigned</span></label>)}{!visible.length && <div className="empty-state"><UsersRound size={22} /><strong>No students found</strong></div>}</div><div className="modal-actions"><button className="button button-secondary" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={isSaving || !selected.length} onClick={() => void save()}>{isSaving ? 'Assigning...' : `Assign to ${selected.length || 0} students`} <ArrowRight size={15} /></button></div></section></div>
}

function AdminBuilderWorkspace({ isNew, quiz, onNavigate, onSaved, notify }: { isNew: boolean; quiz: Quiz | null; onNavigate: (view: AdminView) => void; onSaved: () => Promise<void>; notify: (toast: ToastMessage) => void }) {
  const [title, setTitle] = useState(isNew ? '' : quiz?.title ?? '')
  const [subject, setSubject] = useState(isNew ? DEFAULT_SUBJECT : quiz?.subject ?? DEFAULT_SUBJECT)
  const [description, setDescription] = useState(isNew ? '' : quiz?.description ?? '')
  const [passingScore, setPassingScore] = useState(String(quiz?.passingScore ?? 75))
  const [durationMinutes, setDurationMinutes] = useState(String(quiz?.durationMinutes ?? 30))
  const [parts, setParts] = useState<QuizPart[]>(() => initialParts(quiz, isNew))
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [newSubject, setNewSubject] = useState('')
  const [showNewSubject, setShowNewSubject] = useState(false)
  const [openQuestion, setOpenQuestion] = useState<string | null>(parts[0]?.questions[0]?.id ?? null)
  const [isSaving, setIsSaving] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  useEffect(() => { loadSubjects().then((loaded) => setSubjects(loaded.length ? loaded : [{ id: 'default', name: DEFAULT_SUBJECT }])).catch(() => setSubjects([{ id: 'default', name: DEFAULT_SUBJECT }])) }, [])
  const totalQuestions = parts.reduce((sum, part) => sum + part.questions.length, 0)
  const totalPoints = parts.reduce((sum, part) => sum + part.questions.reduce((partSum, question) => partSum + Number(question.points || 0), 0), 0)
  const updatePart = (partId: string, patch: Partial<QuizPart>) => setParts((current) => current.map((part) => part.id === partId ? { ...part, ...patch } : part))
  const updateQuestion = (partId: string, questionId: string, patch: Partial<Question>) => setParts((current) => current.map((part) => part.id === partId ? { ...part, questions: part.questions.map((question) => question.id === questionId ? { ...question, ...patch } : question) } : part))
  const addPart = () => { const id = newId('part'); const question = blankQuestion(id); setParts((current) => [...current, { id, title: `Part ${current.length + 1}`, position: current.length + 1, questions: [question] }]); setOpenQuestion(question.id) }
  const removePart = (partId: string) => { if (parts.length === 1) return notify({ tone: 'warning', title: 'Keep one quiz part' }); setParts((current) => current.filter((part) => part.id !== partId).map((part, index) => ({ ...part, position: index + 1 }))) }
  const addQuestion = (partId: string) => { const question = blankQuestion(partId); setParts((current) => current.map((part) => part.id === partId ? { ...part, questions: [...part.questions, { ...question, partPosition: part.questions.length + 1 }] } : part)); setOpenQuestion(question.id) }
  const removeQuestion = (partId: string, questionId: string) => setParts((current) => current.map((part) => part.id === partId ? { ...part, questions: part.questions.filter((question) => question.id !== questionId).map((question, index) => ({ ...question, partPosition: index + 1 })) } : part))
  const moveQuestion = (partId: string, index: number, direction: -1 | 1) => setParts((current) => current.map((part) => { if (part.id !== partId) return part; const target = index + direction; if (target < 0 || target >= part.questions.length) return part; const questions = [...part.questions]; const [moved] = questions.splice(index, 1); questions.splice(target, 0, moved); return { ...part, questions: questions.map((question, questionIndex) => ({ ...question, partPosition: questionIndex + 1 })) } }))
  const addSubject = async () => { if (!newSubject.trim()) return; const result = await createSubject(newSubject); if (result.error) return notify({ tone: 'warning', title: 'Subject could not be added', message: result.error.message }); setSubject(newSubject.trim()); setNewSubject(''); setShowNewSubject(false); setSubjects(await loadSubjects()); notify({ tone: 'success', title: 'Subject added' }) }
  const handleImport = async (file: File) => { setIsImporting(true); try { const imported = await importQuizPdf(file); setTitle(imported.title); setDescription(imported.description); setParts(imported.parts); setOpenQuestion(imported.parts[0]?.questions[0]?.id ?? null); notify({ tone: imported.warnings.length ? 'warning' : 'success', title: imported.warnings.length ? 'PDF imported with notes' : 'PDF imported', message: imported.warnings.join(' ') || 'Review the imported questions before saving.' }) } catch (error) { notify({ tone: 'warning', title: 'Could not import PDF', message: (error as Error).message }) } finally { setIsImporting(false); if (fileInput.current) fileInput.current.value = '' } }
  const save = async (publish: boolean) => { if (!title.trim() || !subject || !parts.length || parts.some((part) => !part.title.trim() || !part.questions.length) || parts.some((part) => part.questions.some((question) => !question.prompt.trim()))) return notify({ tone: 'warning', title: 'Complete the quiz details', message: 'Add a title, subject, part titles, and question prompts.' }); if (parts.some((part) => part.questions.some((question) => question.type === 'multiple-choice' && ((!question.options?.length || question.options.some((option) => !option.trim())) || !question.answer?.trim())))) return notify({ tone: 'warning', title: 'Complete the answer choices', message: 'Multiple-choice questions need options and a correct answer.' }); setIsSaving(true); const result = await saveQuiz({ id: quiz?.id, title, subject, description, passingScore: Number(passingScore) || 75, durationMinutes: Number(durationMinutes) || 30, status: publish ? 'published' : 'draft', parts }); setIsSaving(false); if (result.error) return notify({ tone: 'warning', title: publish ? 'Could not publish quiz' : 'Could not save quiz', message: result.error.message }); notify({ tone: 'success', title: publish ? 'Quiz published' : 'Draft saved' }); await onSaved() }
  return <div className="builder-page"><div className="builder-toolbar"><button className="back-link" onClick={() => onNavigate('quizzes')}><ArrowLeft size={16} /> Back to quiz library</button><div className="builder-actions"><input ref={fileInput} type="file" accept="application/pdf,.pdf" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void handleImport(file) }} /><button className="button button-secondary" onClick={() => fileInput.current?.click()} disabled={isImporting}><FileUp size={15} /> {isImporting ? 'Reading PDF...' : 'Import PDF'}</button><button className="button button-secondary" onClick={() => void save(false)} disabled={isSaving}>{isSaving ? 'Saving...' : 'Save draft'}</button><button className="button button-primary" onClick={() => void save(true)} disabled={isSaving}><Send size={15} /> {isSaving ? 'Publishing...' : 'Publish quiz'}</button></div></div><div className="builder-layout"><section className="builder-main"><div className="form-card builder-details-card"><div className="form-card-heading"><div><span className="eyebrow">Quiz details</span><h3>{isNew ? 'Start with the basics' : title || 'Edit quiz'}</h3></div><StatusBadge tone="warning">Draft changes</StatusBadge></div><div className="builder-fields"><div><label className="field-label">Quiz title</label><input className="form-input form-input-large" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Data Representation & CPU" /></div><div className="two-field-grid"><div><label className="field-label">Subject</label><div className="select-wrap"><select className="form-input" value={subject} onChange={(event) => setSubject(event.target.value)}>{subjects.map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}</select><ChevronDown size={16} /></div>{showNewSubject ? <div className="inline-add-row"><input className="form-input" value={newSubject} onChange={(event) => setNewSubject(event.target.value)} placeholder="New subject name" /><button className="button button-small button-primary" onClick={() => void addSubject()}>Add</button></div> : <button className="text-button subject-add-button" onClick={() => setShowNewSubject(true)}><Plus size={13} /> Add subject</button>}</div><div><label className="field-label">Passing score</label><div className="input-suffix"><input className="form-input" value={passingScore} onChange={(event) => setPassingScore(event.target.value)} inputMode="numeric" /><span>%</span></div></div></div><div className="two-field-grid"><div><label className="field-label">Time to answer</label><div className="input-suffix"><input className="form-input" type="number" min="1" max="1440" value={durationMinutes} onChange={(event) => setDurationMinutes(event.target.value)} /><span>min</span></div></div><div><label className="field-label">Total points</label><div className="readonly-input"><ListChecks size={16} /> {totalPoints} points</div></div></div><div><label className="field-label">Instructions for students</label><textarea className="form-input" rows={3} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Add a short note about what students should prepare..." /></div></div></div><section className="form-card"><div className="questions-builder-heading"><div><span className="eyebrow">Structure</span><h3>Parts and questions <span className="heading-muted">{parts.length} parts . {totalQuestions} questions</span></h3></div><button className="button button-secondary" onClick={addPart}><Plus size={15} /> Add part</button></div></section>{parts.map((part, partIndex) => <section className="form-card part-card" key={part.id}><div className="part-card-heading"><div className="part-heading-copy"><span className="eyebrow">Part {partIndex + 1}</span><input className="part-title-input" value={part.title} onChange={(event) => updatePart(part.id, { title: event.target.value })} /></div><div className="part-card-actions"><span className="part-total">{part.questions.length} questions</span><button className="icon-button" onClick={() => removePart(part.id)} aria-label="Remove part"><X size={16} /></button></div></div><div className="builder-question-list">{part.questions.map((question, index) => <BuilderQuestion key={question.id} question={question} index={index} isOpen={openQuestion === question.id} onToggle={() => setOpenQuestion(openQuestion === question.id ? null : question.id)} onUpdate={(patch) => updateQuestion(part.id, question.id, patch)} onRemove={() => removeQuestion(part.id, question.id)} onMoveUp={() => moveQuestion(part.id, index, -1)} onMoveDown={() => moveQuestion(part.id, index, 1)} />)}</div><button className="text-button with-icon builder-add-question" onClick={() => addQuestion(part.id)}><Plus size={15} /> Add question to this part</button></section>)}</section><aside className="builder-aside"><section className="builder-summary-card"><div className="summary-art"><ListChecks size={19} /></div><span className="eyebrow">Assessment summary</span><h3>Ready for review.</h3><p>Imported content stays editable until you save or publish it.</p><div className="checklist"><div className={`checklist-item ${title.trim() ? 'done' : ''}`}><Check size={12} /> Quiz title added</div><div className={`checklist-item ${totalQuestions ? 'done' : ''}`}><Check size={12} /> Questions added</div><div className={`checklist-item ${totalPoints > 0 ? 'done' : ''}`}><Check size={12} /> Points configured</div></div></section><section className="builder-tip"><FileText size={16} /><div><strong>Default time</strong><span>New quizzes start with a 30-minute limit. You can change it above.</span></div></section></aside></div></div>
}

function initialParts(quiz: Quiz | null, isNew: boolean): QuizPart[] {
  if (!isNew && quiz?.parts?.length) return quiz.parts.map((part) => ({ ...part, questions: part.questions.map((question, index) => ({ ...question, partId: part.id, partPosition: index + 1 })) }))
  const partId = quiz?.parts?.[0]?.id ?? newId('part')
  return [{ id: partId, title: quiz?.parts?.[0]?.title ?? 'Part 1', position: 1, questions: quiz?.questionsList?.length ? quiz.questionsList.map((question, index) => ({ ...question, partId, partPosition: index + 1 })) : [blankQuestion(partId)] }]
}

function blankQuestion(partId: string): Question {
  return { id: newId('question'), type: 'multiple-choice', prompt: '', points: 1, options: ['', '', '', ''], partId, partPosition: 1 }
}

function BuilderQuestion({ question, index, isOpen, onToggle, onUpdate, onRemove, onMoveUp, onMoveDown }: { question: Question; index: number; isOpen: boolean; onToggle: () => void; onUpdate: (patch: Partial<Question>) => void; onRemove: () => void; onMoveUp: () => void; onMoveDown: () => void }) {
  const types: Question['type'][] = ['multiple-choice', 'identification', 'essay', 'upload']
  return <div className={`builder-question ${isOpen ? 'open' : ''}`}><button className="builder-question-header" onClick={onToggle}><span className="builder-question-number">{String(index + 1).padStart(2, '0')}</span><span className="builder-question-title"><strong>{question.prompt || 'Untitled question'}</strong><span>{question.type} . {question.points} pts</span></span><ChevronDown size={17} className="builder-chevron" /></button>{isOpen && <div className="builder-question-body"><div className="question-editor-actions"><div className="question-type-row"><div><label className="field-label">Question type</label><div className="type-picker">{types.map((type) => <button key={type} className={question.type === type ? 'active' : ''} onClick={() => onUpdate({ type, requiresReview: type === 'essay' || type === 'upload', options: type === 'multiple-choice' ? question.options?.length ? question.options : ['', '', '', ''] : undefined })}>{type}</button>)}</div></div><div className="points-field"><label className="field-label">Points</label><input className="form-input" type="number" min="1" value={question.points} onChange={(event) => onUpdate({ points: Number(event.target.value) || 1 })} /></div></div><div className="question-reorder-actions"><button className="icon-button" onClick={onMoveUp} aria-label="Move question up"><ChevronUp size={15} /></button><button className="icon-button" onClick={onMoveDown} aria-label="Move question down"><ChevronDown size={15} /></button><button className="icon-button" onClick={onRemove} aria-label="Remove question"><X size={15} /></button></div></div><label className="field-label">Question prompt</label><textarea className="form-input" rows={3} value={question.prompt} onChange={(event) => onUpdate({ prompt: event.target.value })} placeholder="Write the question students will answer..." />{question.type === 'multiple-choice' && <div className="option-builder"><label className="field-label">Answer choices</label>{(question.options ?? ['', '', '', '']).map((option, optionIndex) => <div className="builder-option" key={optionIndex}><input className="form-input" value={option} onChange={(event) => onUpdate({ options: (question.options ?? ['', '', '', '']).map((item, index) => index === optionIndex ? event.target.value : item) })} placeholder={`Choice ${String.fromCharCode(65 + optionIndex)}`} /><button className={`correct-toggle ${question.answer === option && option ? 'correct' : ''}`} onClick={() => onUpdate({ answer: option })} aria-label="Mark correct answer">{question.answer === option ? <Check size={13} /> : String.fromCharCode(65 + optionIndex)}</button></div>)}</div>}{question.type === 'identification' && <div><label className="field-label">Answer key</label><input className="form-input" value={question.answer ?? ''} onChange={(event) => onUpdate({ answer: event.target.value })} /></div>}{question.requiresReview && <div className="manual-review-note"><CircleAlert size={15} /> This response will be reviewed manually.</div>}</div>}</div>
}

function AdminStudentsPage({ focusStudentId, notify }: { focusStudentId: string | null; notify: (toast: ToastMessage) => void }) {
  const [students, setStudents] = useState<Student[]>([])
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<Student | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const refresh = async () => { try { setStudents(await loadAdminRoster()) } catch (error) { notify({ tone: 'warning', title: 'Students could not load', message: (error as Error).message }) } }
  useEffect(() => { void refresh() }, [])
  useEffect(() => { if (focusStudentId) setSearch(focusStudentId) }, [focusStudentId])
  const filtered = sortStudents(students.filter((student) => `${student.schoolId} ${student.firstNames} ${student.lastName}`.toLowerCase().includes(search.toLowerCase())))
  const save = async (student: Student) => { setIsSaving(true); const result = await saveStudent(student, editing?.schoolId); setIsSaving(false); if (result.error) return notify({ tone: 'warning', title: 'Student could not be saved', message: result.error.message }); notify({ tone: 'success', title: editing ? 'Student updated' : 'Student added', message: editing ? 'The roster record is up to date.' : `The default password is ${DEFAULT_STUDENT_PASSWORD}.` }); setEditing(null); await refresh() }
  const reset = async (student: Student) => { const result = await resetStudentPassword(student.schoolId); if (result.error) return notify({ tone: 'warning', title: 'Password reset failed', message: result.error.message }); notify({ tone: 'success', title: 'Password reset', message: `${displayName(student)} can sign in with the default password.` }); await refresh() }
  return <div className="content-stack"><section className="page-intro-row admin-page-intro"><div><span className="eyebrow">Roster and access</span><h2>Manage students.</h2><p>Add or edit roster records, then reset a password when a student requests help.</p></div><button className="button button-primary" onClick={() => setEditing({ schoolId: '', firstNames: '', lastName: '', active: true })}><Plus size={17} /> Add student</button></section><section className="table-card roster-table-card"><div className="table-card-heading"><div><span className="eyebrow">Verified roster</span><h3>{students.length} students</h3></div><div className="search-wrap"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search school ID or name" /></div></div><div className="roster-table"><div className="roster-table-head"><span>Student</span><span>School ID</span><span>Account</span><span>Assignments</span><span /></div>{filtered.map((student) => <div className="roster-row roster-row-five" key={student.schoolId}><button className="roster-student roster-name-button" onClick={() => setEditing(student)}><span className="avatar avatar-tiny avatar-mint">{initials(student)}</span><strong>{displayName(student)}</strong></button><span className="school-id-text">{student.schoolId}</span><span className="assignment-count">{student.accountReady ? student.mustChangePassword ? 'Change required' : 'Ready' : 'Missing account'}</span><span className="assignment-count">{student.assignmentCount ?? 0}</span><button className="button button-small button-secondary" onClick={() => void reset(student)}>Reset password</button></div>)}{!filtered.length && <div className="empty-state"><UsersRound size={24} /><strong>No students found</strong><span>Try another search or add a student.</span></div>}</div></section>{editing && <StudentModal student={editing} isSaving={isSaving} isNew={!students.some((item) => item.schoolId === editing.schoolId)} onClose={() => setEditing(null)} onSave={save} onReset={() => void reset(editing)} />}</div>
}

function StudentModal({ student, isNew, isSaving, onClose, onSave, onReset }: { student: Student; isNew: boolean; isSaving: boolean; onClose: () => void; onSave: (student: Student) => Promise<void>; onReset: () => void }) {
  const [value, setValue] = useState(student)
  const submit = (event: FormEvent) => { event.preventDefault(); void onSave(value) }
  return <div className="modal-overlay" onClick={onClose}><section className="student-modal" onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><span className="eyebrow eyebrow-accent">{isNew ? 'Add student' : 'Student account'}</span><h2>{isNew ? 'Create roster record' : displayName(student)}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close student form"><X size={18} /></button></div><form className="settings-fields" onSubmit={submit}><div><label className="field-label">School ID</label><input className="form-input" value={value.schoolId} disabled={!isNew} onChange={(event) => setValue({ ...value, schoolId: event.target.value })} placeholder="24-00392" /></div><div className="two-field-grid"><div><label className="field-label">First and middle names</label><input className="form-input" value={value.firstNames} onChange={(event) => setValue({ ...value, firstNames: event.target.value })} /></div><div><label className="field-label">Last name</label><input className="form-input" value={value.lastName} onChange={(event) => setValue({ ...value, lastName: event.target.value })} /></div></div><label className="check-row"><input type="checkbox" checked={value.active !== false} onChange={(event) => setValue({ ...value, active: event.target.checked })} /><span className="custom-check"><Check size={12} /></span><span>Account is active</span></label><div className="info-callout"><ShieldCheck size={17} /><span>{isNew ? `New accounts start with ${DEFAULT_STUDENT_PASSWORD} and must change it after first login.` : 'Resetting a password restores the default password and requires a change at next login.'}</span></div><div className="modal-actions"><button type="button" className="button button-secondary" onClick={onClose}>Cancel</button>{!isNew && <button type="button" className="button button-secondary" onClick={onReset}>Reset password</button>}<button type="submit" className="button button-primary" disabled={isSaving}>{isSaving ? 'Saving...' : isNew ? 'Add student' : 'Save changes'} <Check size={15} /></button></div></form></section></div>
}

function submissionStatusLabel(status: Submission['status']) {
  if (status === 'needs-review') return 'Needs review'
  if (status === 'in-progress') return 'In progress'
  return 'Graded'
}

function submissionStatusTone(status: Submission['status']): 'success' | 'warning' | 'blue' {
  if (status === 'needs-review') return 'warning'
  if (status === 'in-progress') return 'blue'
  return 'success'
}

function submissionDate(value: string | null) {
  return value ? new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Still in progress'
}

function quizCardTone(subject: string): 'blue' | 'mint' | 'peach' | 'purple' {
  const value = subject.toLowerCase()
  if (value.includes('web') || value.includes('network')) return 'mint'
  if (value.includes('data') || value.includes('database')) return 'peach'
  if (value.includes('architecture')) return 'blue'
  return 'purple'
}

function submissionFullName(student: Student) {
  return `${student.lastName}, ${student.firstNames}`
}

function formatSubmissionPoints(value: number) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)))
}

function submissionPartKey(partId: string | null) {
  return partId ?? '__general'
}

function compactPartScore(submission: Submission, part: SubmissionPartColumn) {
  const score = submission.parts?.find((item) => submissionPartKey(item.partId) === submissionPartKey(part.partId))
  const possible = score?.possible ?? part.possiblePoints
  if (!score && !possible) return '—'
  return `${formatSubmissionPoints(score?.earned ?? 0)} / ${formatSubmissionPoints(possible)}`
}

function CompactSubmissionTable({ submissions, partColumns, onOpen }: { submissions: Submission[]; partColumns: SubmissionPartColumn[]; onOpen: (submission: Submission) => void }) {
  const gridTemplateColumns = `minmax(180px, 1.45fr) repeat(${partColumns.length}, minmax(90px, 1fr)) minmax(86px, 0.75fr)`
  return <div className="submission-compact-scroll"><div className="submission-compact-table" style={{ gridTemplateColumns }}><div className="submission-compact-head" style={{ gridTemplateColumns }}><span>Student</span>{partColumns.map((part) => <span key={submissionPartKey(part.partId)}>{part.title}</span>)}<span>Total</span></div>{submissions.map((submission) => <button className="submission-compact-row" key={submission.id} type="button" style={{ gridTemplateColumns }} onClick={() => onOpen(submission)}><span className="submission-compact-student"><span className="avatar avatar-tiny avatar-mint">{initials(submission.student)}</span><strong>{submissionFullName(submission.student)}</strong></span>{partColumns.map((part) => <span key={submissionPartKey(part.partId)}>{compactPartScore(submission, part)}</span>)}<strong>{formatSubmissionPoints(submission.earnedPoints)} / {formatSubmissionPoints(submission.possiblePoints)}</strong></button>)}</div></div>
}

function AdminSubmissions({ notify = () => undefined }: { notify?: (toast: ToastMessage) => void }) {
  const [submissions, setSubmissions] = useState<Submission[]>([])
  const [filter, setFilter] = useState<'all' | Submission['status']>('all')
  const [search, setSearch] = useState('')
  const [quizFilter, setQuizFilter] = useState('all')
  const [selected, setSelected] = useState<Submission | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [compactView, setCompactView] = useState(false)

  const refresh = async () => {
    setIsLoading(true)
    try {
      setSubmissions(await loadAdminSubmissions())
    } catch (error) {
      notify({ tone: 'warning', title: 'Submissions could not load', message: (error as Error).message })
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => { void refresh() }, [])
  useEffect(() => { if (quizFilter === 'all') setCompactView(false) }, [quizFilter])

  const quizOptions = [...new Map(submissions.map((submission) => [submission.quizId, submission.quizTitle])).entries()]
    .sort((left, right) => left[1].localeCompare(right[1], 'en', { sensitivity: 'base' }))
  const searchTerm = search.trim().toLowerCase()
  const filtered = submissions.filter((submission) => {
    const matchesStatus = filter === 'all' || submission.status === filter
    const matchesQuiz = quizFilter === 'all' || submission.quizId === quizFilter
    const matchesSearch = !searchTerm || `${submission.student.firstNames} ${submission.student.lastName} ${submission.student.schoolId} ${submission.quizTitle}`.toLowerCase().includes(searchTerm)
    return matchesStatus && matchesQuiz && matchesSearch
  })
  const canUseCompactView = quizFilter !== 'all'
  const compactPartColumns = [...new Map(
    submissions
      .filter((submission) => submission.quizId === quizFilter)
      .flatMap((submission) => submission.partColumns)
      .map((part) => [submissionPartKey(part.partId), part] as const),
  ).values()].sort((left, right) => left.position - right.position)
  const filters: Array<{ id: 'all' | Submission['status']; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'needs-review', label: 'Needs review' },
    { id: 'graded', label: 'Graded' },
    { id: 'in-progress', label: 'In progress' },
  ]

  /*

  return <div className="content-stack"><section className="page-intro-row admin-page-intro"><div><span className="eyebrow">Review queue</span><h2>Student submissions.</h2><p>Review every taken exam, correct grading decisions, and keep the record accurate.</p></div><span className="submission-total">{submissions.length} attempt{submissions.length === 1 ? '' : 's'}</span></section><section className="submission-toolbar"><div className="filter-tabs compact-tabs">{filters.map((item) => <button key={item.id} className={filter === item.id ? 'active' : ''} onClick={() => setFilter(item.id)}>{item.label}<span>{item.id === 'all' ? submissions.length : submissions.filter((submission) => submission.status === item.id).length}</span></button>)}</div><div className="submission-filters"><div className="search-wrap"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search student or quiz" /></div><label className="submission-quiz-filter"><span className="visually-hidden">Filter by quiz</span><select value={quizFilter} onChange={(event) => setQuizFilter(event.target.value)}><option value="all">All quizzes</option>{quizOptions.map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select><ChevronDown size={15} /></label></div></section><section className="submission-table-card">{isLoading ? <div className="empty-state"><ClipboardCheck size={24} /><strong>Loading submissions...</strong><span>Fetching taken exams from the workspace.</span></div> : filtered.length ? <><div className="submission-table-head"><span>Student</span><span>Quiz</span><span>Status</span><span>Submitted</span><span>Score</span><span /></div><div className="submission-table"><div>{filtered.map((submission) => <div className="submission-row submission-row-full" key={submission.id}><div className="submission-student"><span className="avatar avatar-tiny avatar-mint">{initials(submission.student)}</span><div><strong>{displayName(submission.student)}</strong><span>{submission.student.schoolId}</span></div></div><div className="submission-quiz"><strong>{submission.quizTitle}</strong><span>Attempt {submission.attemptNumber} · {submission.quizSubject}</span></div><StatusBadge tone={submissionStatusTone(submission.status)}>{submissionStatusLabel(submission.status)}</StatusBadge><span className="submission-date">{submissionDate(submission.submittedAt)}</span><div className="submission-score"><strong>{submission.score !== null ? `${submission.score}%` : `${submission.autoScore}% auto`}</strong><span>{submission.earnedPoints} / {submission.possiblePoints} pts</span></div><button className="button button-small button-secondary" onClick={() => setSelected(submission)}>{submission.status === 'in-progress' ? 'View' : 'Review'}</button></div>)}</div></> : <div className="empty-state"><ClipboardCheck size={24} /><strong>No submissions found</strong><span>Try a different status, quiz, or search term.</span></div>}</section>{selected && <SubmissionReviewDrawer submission={selected} notify={notify} onClose={() => setSelected(null)} onSaved={async () => { await refresh(); setSelected(null) }} onDeleted={async () => { await refresh(); setSelected(null) }} />}</div>
}

  */
  return (
    <div className="content-stack">
      <section className="page-intro-row admin-page-intro">
        <div>
          <span className="eyebrow">Review queue</span>
          <h2>Student submissions.</h2>
          <p>Review every taken exam, correct grading decisions, and keep the record accurate.</p>
        </div>
        <span className="submission-total">{submissions.length} attempt{submissions.length === 1 ? '' : 's'}</span>
      </section>
      <section className="submission-toolbar">
        <div className="filter-tabs compact-tabs">
          {filters.map((item) => <button key={item.id} className={filter === item.id ? 'active' : ''} onClick={() => setFilter(item.id)}>{item.label}<span>{item.id === 'all' ? submissions.length : submissions.filter((submission) => submission.status === item.id).length}</span></button>)}
        </div>
        <div className="submission-filters">
          <div className="search-wrap"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search student or quiz" /></div>
          <label className="submission-quiz-filter"><span className="visually-hidden">Filter by quiz</span><select value={quizFilter} onChange={(event) => setQuizFilter(event.target.value)}><option value="all">All quizzes</option>{quizOptions.map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select><ChevronDown size={15} /></label>
          <button className="button button-secondary submission-layout-toggle" disabled={!canUseCompactView} aria-pressed={compactView} title={canUseCompactView ? 'Toggle compact score columns' : 'Select one quiz to use compact columns'} onClick={() => setCompactView((value) => !value)}>{compactView ? 'Full layout' : 'Compact layout'}</button>
        </div>
      </section>
      <section className="submission-table-card">
        {isLoading ? <div className="empty-state"><ClipboardCheck size={24} /><strong>Loading submissions...</strong><span>Fetching taken exams from the workspace.</span></div> : filtered.length ? compactView && canUseCompactView ? <CompactSubmissionTable submissions={filtered} partColumns={compactPartColumns} onOpen={setSelected} /> : <>
          <div className="submission-table-head"><span>Student</span><span>Quiz</span><span>Status</span><span>Submitted</span><span>Score</span><span /></div>
          <div className="submission-table">
            {filtered.map((submission) => <div className="submission-row submission-row-full" key={submission.id}>
              <div className="submission-student"><span className="avatar avatar-tiny avatar-mint">{initials(submission.student)}</span><div><strong>{displayName(submission.student)}</strong><span>{submission.student.schoolId}</span></div></div>
              <div className="submission-quiz"><strong>{submission.quizTitle}</strong><span>Attempt {submission.attemptNumber} · {submission.quizSubject}</span></div>
              <StatusBadge tone={submissionStatusTone(submission.status)}>{submissionStatusLabel(submission.status)}</StatusBadge>
              <span className="submission-date">{submissionDate(submission.submittedAt)}</span>
              <div className="submission-score"><strong>{submission.score !== null ? `${submission.score}%` : `${submission.autoScore}% auto`}</strong><span>{submission.earnedPoints} / {submission.possiblePoints} pts</span></div>
              <button className="button button-small button-secondary" onClick={() => setSelected(submission)}>{submission.status === 'in-progress' ? 'View' : 'Review'}</button>
            </div>)}
          </div>
        </> : <div className="empty-state"><ClipboardCheck size={24} /><strong>No submissions found</strong><span>Try a different status, quiz, or search term.</span></div>}
      </section>
      {selected && <SubmissionReviewDrawer submission={selected} notify={notify} onClose={() => setSelected(null)} onSaved={async () => { await refresh(); setSelected(null) }} onDeleted={async () => { await refresh(); setSelected(null) }} />}
    </div>
  )
}

function SubmissionReviewDrawer({ submission, notify, onClose, onSaved, onDeleted }: { submission: Submission; notify: (toast: ToastMessage) => void; onClose: () => void; onSaved: () => Promise<void>; onDeleted: () => Promise<void> }) {
  const [answers, setAnswers] = useState<SubmissionAnswer[]>(submission.answers)
  const [isSaving, setIsSaving] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const canGrade = submission.status !== 'in-progress'

  useEffect(() => setAnswers(submission.answers), [submission.id, submission.answers])

  const updateAnswer = (questionId: string, patch: Partial<SubmissionAnswer>) => {
    setAnswers((current) => current.map((answer) => answer.questionId === questionId ? { ...answer, ...patch } : answer))
  }

  const save = async () => {
    setIsSaving(true)
    const result = await reviewSubmission(submission.id, answers)
    setIsSaving(false)
    if (result.error) return notify({ tone: 'warning', title: 'Submission could not be saved', message: result.error.message })
    notify({ tone: 'success', title: 'Submission grading updated', message: 'The final score and part scores were recalculated.' })
    await onSaved()
  }

  const remove = async () => {
    setIsDeleting(true)
    const result = await deleteSubmission(submission.id)
    setIsDeleting(false)
    if (result.error) return notify({ tone: 'warning', title: 'Submission could not be deleted', message: result.error.message })
    setConfirmDelete(false)
    notify({ tone: 'success', title: 'Submission deleted', message: 'The attempt and its answers were removed.' })
    await onDeleted()
  }

  const earnedPoints = answers.reduce((sum, answer) => sum + Number(answer.pointsAwarded || 0), 0)
  return <div className="drawer-overlay" onClick={onClose}><section className="review-drawer" role="dialog" aria-modal="true" aria-labelledby="submission-review-title" onClick={(event) => event.stopPropagation()}><header className="drawer-header"><div><span className="eyebrow eyebrow-accent">Submission review</span><h2 id="submission-review-title">{submission.quizTitle}</h2><span>{displayName(submission.student)} · Attempt {submission.attemptNumber} · {submissionDate(submission.submittedAt)}</span></div><button className="icon-button" onClick={onClose} aria-label="Close submission review"><X size={18} /></button></header><div className="drawer-content"><div className="drawer-student-card"><span className="avatar avatar-small avatar-mint">{initials(submission.student)}</span><div><strong>{displayName(submission.student)}</strong><span>{submission.student.schoolId} · {submission.quizSubject}</span></div><StatusBadge tone={submissionStatusTone(submission.status)}>{submissionStatusLabel(submission.status)}</StatusBadge></div><div className="review-score-summary"><div><span>Current final score</span><strong>{submission.score === null ? 'Pending' : `${submission.score}%`}</strong></div><div><span>Edited total</span><strong>{earnedPoints} / {submission.possiblePoints} pts</strong></div><div><span>Auto score</span><strong>{submission.autoScore}%</strong></div></div>{!canGrade && <div className="info-callout"><CircleAlert size={17} /><span>This attempt is still in progress. You can delete it, but grading becomes available after submission.</span></div>}<div className="review-answer-list">{answers.map((answer, index) => <article className="manual-answer-card" key={answer.questionId}><div className="manual-answer-heading"><div><span className="eyebrow">Question {index + 1} · {answer.type}</span><h3>{answer.prompt}</h3></div><span className="points-pill">{answer.points} pts possible</span></div><div className="student-answer"><span>Answer:</span><strong>{answer.answer || 'No answer submitted'}</strong></div><div className="correct-answer"><span>Correct answer:</span><strong>{answer.correctAnswer || 'No fixed answer provided'}</strong></div><div className="manual-score-row"><div><label className="field-label" htmlFor={`submission-points-${answer.questionId}`}>Points awarded</label><div className="points-input"><input id={`submission-points-${answer.questionId}`} type="number" min="0" max={answer.points} step="0.01" value={answer.pointsAwarded} disabled={!canGrade} onChange={(event) => updateAnswer(answer.questionId, { pointsAwarded: Math.min(answer.points, Math.max(0, Number(event.target.value) || 0)) })} /><span>/ {answer.points}</span></div></div><label className="review-correct-toggle"><input type="checkbox" checked={answer.isCorrect === true} disabled={!canGrade} onChange={(event) => updateAnswer(answer.questionId, { isCorrect: event.target.checked, ...(event.target.checked ? { pointsAwarded: answer.points } : {}) })} /><span>Mark correct</span></label></div></article>)}</div></div><footer className="drawer-footer"><button className="button button-ghost danger-button" disabled={isDeleting} onClick={() => setConfirmDelete(true)}><Trash2 size={14} /> {isDeleting ? 'Deleting...' : 'Delete submission'}</button><button className="button button-secondary" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={!canGrade || isSaving} onClick={() => void save()}>{isSaving ? 'Saving...' : 'Save grading'} <Check size={15} /></button></footer>{confirmDelete && <ConfirmModal title="Delete this submission?" message="The attempt, answers, and part scores will be permanently removed. This cannot be undone." confirmLabel={isDeleting ? 'Deleting...' : 'Delete submission'} onCancel={() => setConfirmDelete(false)} onConfirm={() => void remove()} />}</section></div>
}

function AuthLoadingScreen() {
  return <main className="auth-loading-screen" aria-busy="true"><Brand /><span>Restoring your workspace...</span></main>
}

function NotificationCenter({ notifications, unread, onOpen }: { notifications: Notification[]; unread: number; onOpen: (notification: Notification) => void }) {
  const [open, setOpen] = useState(false)
  return <div className="notification-anchor"><button className="icon-button notification-button" aria-label="Notifications" onClick={() => setOpen((value) => !value)}><Bell size={19} />{unread > 0 && <span>{unread > 9 ? '9+' : unread}</span>}</button>{open && <div className="notification-popover"><div className="notification-heading"><strong>Notifications</strong><span>{unread ? `${unread} unread` : 'All caught up'}</span></div>{notifications.length ? notifications.map((notification) => <button key={notification.id} className={`notification-row ${notification.readAt ? '' : 'unread'}`} onClick={() => { setOpen(false); onOpen(notification) }}><span className="notification-icon"><CircleAlert size={15} /></span><span><strong>{notification.title}</strong><small>{notification.message}</small><time>{new Date(notification.createdAt).toLocaleString()}</time></span></button>) : <div className="notification-empty">No notifications yet.</div>}</div>}</div>
}

function StatCard({ icon, label, value, detail, tone }: { icon: ReactNode; label: string; value: string; detail: string; tone: string }) {
  return <article className="stat-card"><span className={`stat-icon stat-icon-${tone}`}>{icon}</span><div className="stat-card-copy"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div></article>
}

function AdminStat({ icon, value, label, detail, tone }: { icon: ReactNode; value: string; label: string; detail: string; tone: string }) {
  return <article className="admin-stat-card"><span className={`admin-stat-icon admin-stat-icon-${tone}`}>{icon}</span><div><strong>{value}</strong><span>{label}</span><small>{detail}</small></div></article>
}

function StatusBadge({ children, tone, icon }: { children: ReactNode; tone: 'success' | 'warning' | 'neutral' | 'purple' | 'blue' | 'danger'; icon?: ReactNode }) {
  return <span className={`status-badge status-${tone}`}>{icon}{children}</span>
}

function Toast({ toast, onClose }: { toast: ToastMessage; onClose: () => void }) {
  return <div className={`toast toast-${toast.tone ?? 'info'}`}><span className="toast-icon">{toast.tone === 'success' ? <CheckCircle2 size={18} /> : toast.tone === 'warning' ? <CircleAlert size={18} /> : <Sparkles size={18} />}</span><div><strong>{toast.title}</strong>{toast.message && <span>{toast.message}</span>}</div><button className="icon-button" onClick={onClose} aria-label="Close notification"><X size={16} /></button></div>
}

function Brand({ dark = false }: { dark?: boolean }) {
  return <div className={`brand ${dark ? 'brand-on-dark' : ''}`}><span className="brand-mark brand-logo"><img src={latequizLogo} alt="" /></span><span>LateQuiz</span></div>
}

function StudentAvatar({ student, className = 'avatar avatar-small' }: { student: Student; className?: string }) {
  return <span className={className}>{student.avatar ? <img className="avatar-image" src={student.avatar} alt="" /> : initials(student)}</span>
}

function ConfirmModal({ title, message, confirmLabel, onCancel, onConfirm }: { title: string; message: string; confirmLabel: string; onCancel: () => void; onConfirm: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  return <div className="modal-overlay" role="presentation" onClick={onCancel}><section className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title" onClick={(event) => event.stopPropagation()}><div className="modal-icon confirm-icon"><CircleAlert size={21} /></div><div className="modal-heading"><div><span className="eyebrow eyebrow-accent">Please confirm</span><h2 id="confirm-title">{title}</h2><p>{message}</p></div><button className="icon-button" onClick={onCancel} aria-label="Close confirmation"><X size={18} /></button></div><div className="modal-actions"><button className="button button-secondary" onClick={onCancel}>Cancel</button><button className="button button-primary" onClick={onConfirm}>{confirmLabel}</button></div></section></div>
}

function AuthScreen({ route, onNavigate, onLogin, notify }: { route: AuthRoute; onNavigate: (route: AuthRoute) => void; onLogin: (role: Role, student?: Student, mustChangePassword?: boolean) => void; notify: (toast: ToastMessage) => void }) {
  const isAdmin = route === 'admin'
  const [identity, setIdentity] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isForgot, setIsForgot] = useState(false)

  useEffect(() => {
    setIdentity('')
    setPassword('')
    setShowPassword(false)
    setIsForgot(false)
  }, [route])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!identity.trim() || !password.trim()) {
      notify({ tone: 'warning', title: 'Complete the fields', message: isAdmin ? 'Enter your admin username and password.' : 'Enter your school ID and password.' })
      return
    }
    setIsLoading(true)
    const result = isAdmin ? await signInWithAdminUsername(identity, password) : await signInWithSchoolId(identity, password)
    if (result.error || !result.data?.user || !supabase) {
      notify({ tone: 'warning', title: 'Login failed', message: result.error?.message ?? 'The account is not available.' })
      setIsLoading(false)
      return
    }

    const { data: profile, error: profileError } = await supabase.from('LQ_profiles').select('role, school_id, must_change_password, avatar_url').eq('id', result.data.user.id).maybeSingle()
    if (profileError || !profile) {
      await signOut()
      notify({ tone: 'warning', title: 'Profile setup incomplete', message: 'Your account does not have a LateQuiz profile yet.' })
      setIsLoading(false)
      return
    }
    if ((isAdmin && profile.role !== 'admin') || (!isAdmin && profile.role === 'admin')) {
      await signOut()
      notify({ tone: 'warning', title: 'Wrong login portal', message: isAdmin ? 'Use the student login mode for student accounts.' : 'Use the administrator login mode for administrator accounts.' })
      setIsLoading(false)
      return
    }

    let resolvedStudent: Student | undefined
    if (!isAdmin && profile.school_id) {
      const { data: rosterRecord } = await supabase.from('LQ_student_roster').select('school_id, last_name, first_names, is_active').eq('school_id', profile.school_id).maybeSingle()
      if (!rosterRecord || rosterRecord.is_active === false) {
        await signOut()
        notify({ tone: 'warning', title: 'Account unavailable', message: 'This student account is not active.' })
        setIsLoading(false)
        return
      }
      const avatar = await signedAvatarUrl(profile.avatar_url)
      resolvedStudent = { schoolId: rosterRecord.school_id, lastName: rosterRecord.last_name, firstNames: rosterRecord.first_names, avatarPath: profile.avatar_url ?? undefined, avatar: avatar.url ?? undefined }
    }
    onLogin(isAdmin ? 'admin' : 'student', resolvedStudent, Boolean(profile.must_change_password))
    notify({ tone: 'success', title: isAdmin ? 'Welcome to the admin workspace' : 'Welcome back', message: 'Your LateQuiz workspace is ready.' })
    setIsLoading(false)
  }

  const submitResetRequest = async (event: FormEvent) => {
    event.preventDefault()
    if (!identity.trim()) {
      notify({ tone: 'warning', title: 'Enter your school ID', message: 'Your administrator needs it to identify the account.' })
      return
    }
    setIsLoading(true)
    const result = await requestPasswordReset(identity)
    setIsLoading(false)
    if (result.error) {
      notify({ tone: 'warning', title: 'Request could not be sent', message: result.error.message })
      return
    }
    notify({ tone: 'success', title: 'Request sent', message: 'Your administrator has been notified.' })
    setIsForgot(false)
  }

  return <main className={`auth-page auth-enter ${isAdmin ? 'auth-page-admin' : ''}`}>
    <section className="auth-visual"><Brand dark /><div className="auth-visual-copy"><span className="eyebrow eyebrow-light">{isAdmin ? 'A clear command center' : 'A softer way back on track'}</span><h1>{isAdmin ? <>Keep every<br /><em>quiz moving.</em></> : <>One late quiz<br /><em>at a time.</em></>}</h1><p>{isAdmin ? 'Manage students, publish assessments, and give every submission the attention it deserves.' : 'Pick up where you left off, see exactly what to improve, and keep your term moving forward.'}</p></div><div className="auth-quote"><Sparkles size={18} /><span>{isAdmin ? 'Simple tools for focused review.' : 'Built for progress, not pressure.'}</span></div><div className="auth-visual-decoration"><div className="floating-note note-one"><Check size={15} /><span>{isAdmin ? 'Publish with confidence' : 'Small steps count'}</span></div><div className="floating-note note-two"><Target size={15} /><span>{isAdmin ? 'Students stay on track' : '75% goal in sight'}</span></div><div className="visual-ring ring-one" /><div className="visual-ring ring-two" /></div></section>
    <section className="auth-panel"><div className="auth-panel-inner"><div className="mobile-brand"><Brand /></div><div className="auth-heading"><span className="eyebrow">{isAdmin ? 'Administrator access' : 'Student portal'}</span><h2>{isForgot ? 'Request a password reset' : isAdmin ? 'Admin workspace' : 'Sign in to continue'}</h2><p>{isForgot ? 'Enter your school ID and your administrator will receive a reset request.' : isAdmin ? 'Review submissions, manage assignments, and keep students moving.' : 'Your school ID is your key to every assigned quiz.'}</p></div>{isForgot ? <form className="reset-card" onSubmit={submitResetRequest}><div className="reset-icon"><ShieldCheck size={22} /></div><h3>Ask your administrator</h3><p>Your account will be reset to the default password after your administrator approves the request.</p><label className="field-label" htmlFor="reset-school-id">School ID</label><div className="input-wrap"><UserRound size={18} /><input id="reset-school-id" value={identity} onChange={(event) => setIdentity(event.target.value)} placeholder="e.g. 24-00392" /></div><button className="button button-primary button-full" disabled={isLoading} type="submit">{isLoading ? 'Sending...' : 'Send reset request'} <Send size={15} /></button><button className="button button-secondary button-full" type="button" onClick={() => setIsForgot(false)}>Back to login</button></form> : <form className="auth-form" onSubmit={submit}><label className="field-label" htmlFor="identity">{isAdmin ? 'Admin username' : 'School ID'}</label><div className="input-wrap"><UserRound size={18} /><input id="identity" value={identity} onChange={(event) => setIdentity(event.target.value)} placeholder={isAdmin ? 'Enter admin username' : 'e.g. 24-00392'} autoComplete="username" /></div><div className="field-label-row"><label className="field-label" htmlFor="password">Password</label>{!isAdmin && <button type="button" className="text-button" onClick={() => setIsForgot(true)}>Forgot password?</button>}</div><div className="input-wrap"><LockIcon /><input id="password" value={password} onChange={(event) => setPassword(event.target.value)} type={showPassword ? 'text' : 'password'} placeholder="Enter your password" autoComplete="current-password" /><button type="button" className="input-action" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div>{!isAdmin && <p className="auth-hint">New or reset student accounts start with the default password provided by your administrator.</p>}<button className="button button-primary button-full button-large" disabled={isLoading} type="submit">{isLoading ? 'Checking...' : isAdmin ? 'Enter admin workspace' : 'Continue'} <ArrowRight size={17} /></button></form>}<div className="auth-route-switch">{isAdmin ? <><span>Student account?</span><button className="text-button" onClick={() => onNavigate('student')}>Use student login</button></> : <><span>Are you an administrator?</span><button className="button button-secondary" onClick={() => onNavigate('admin')}><ShieldCheck size={14} /> Admin login</button></>}</div><p className="auth-footer">Need help? Contact your LateQuiz administrator.</p></div></section>
  </main>
}

function PasswordChangePage({ student, onComplete, onLogout, notify }: { student: Student; onComplete: () => void; onLogout: () => void; notify: (toast: ToastMessage) => void }) {
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (password.length < 8) return notify({ tone: 'warning', title: 'Use a stronger password', message: 'Your password must contain at least 8 characters.' })
    if (password === DEFAULT_STUDENT_PASSWORD) return notify({ tone: 'warning', title: 'Choose a new password', message: 'The default password cannot be reused.' })
    if (password !== confirmation) return notify({ tone: 'warning', title: 'Passwords do not match' })
    setIsSaving(true)
    const result = await changePassword(password)
    setIsSaving(false)
    if (result.error) return notify({ tone: 'warning', title: 'Password could not be changed', message: result.error.message })
    notify({ tone: 'success', title: 'Password updated', message: 'Your account is ready.' })
    onComplete()
  }
  return <main className="password-gate"><section className="password-gate-card"><Brand /><div className="reset-icon"><ShieldCheck size={22} /></div><span className="eyebrow eyebrow-accent">First sign-in</span><h1>Choose your private password.</h1><p>Welcome, {displayName(student).split(' ')[0]}. For your protection, change the default password before entering your quizzes.</p><form className="auth-form" onSubmit={submit}><label className="field-label" htmlFor="new-password">New password</label><input className="form-input" id="new-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" /><label className="field-label" htmlFor="confirm-password">Confirm new password</label><input className="form-input" id="confirm-password" type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password" /><button className="button button-primary button-full" disabled={isSaving} type="submit">{isSaving ? 'Saving...' : 'Save password'} <ArrowRight size={16} /></button></form><button className="text-button" onClick={onLogout}>Sign out</button></section></main>
}

function Sidebar({ role, active, onNavigate, onLogout, student, mobileOpen, onClose, disabled = false }: { role: Role; active: string; onNavigate: (view: string) => void; onLogout: () => void; student?: Student; mobileOpen: boolean; onClose: () => void; disabled?: boolean }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const items = role === 'student' ? [{ id: 'dashboard', label: 'Overview', icon: Home }, { id: 'quizzes', label: 'Quizzes', icon: FolderKanban }, { id: 'scores', label: 'Score history', icon: BarChart3 }, { id: 'account', label: 'My account', icon: UserRound }] : [{ id: 'overview', label: 'Overview', icon: LayoutDashboard }, { id: 'quizzes', label: 'Quiz library', icon: FolderKanban }, { id: 'submissions', label: 'Submissions', icon: ClipboardCheck }, { id: 'students', label: 'Students', icon: UsersRound }]
  return <><>{mobileOpen && !disabled && <button className="sidebar-backdrop" onClick={onClose} aria-label="Close navigation" />}</><aside className={`sidebar ${role === 'admin' ? 'sidebar-admin' : ''} ${mobileOpen ? 'sidebar-open' : ''} ${disabled ? 'sidebar-disabled' : ''}`} aria-label={role === 'admin' ? 'Admin navigation' : 'Student navigation'}><div className="sidebar-top"><Brand dark /><span className="sidebar-role">{role === 'admin' ? 'ADMIN CONSOLE' : 'STUDENT PORTAL'}</span><nav className="side-nav"><span className="nav-section-label">Workspace</span>{items.map((item) => { const Icon = item.icon; return <button key={item.id} disabled={disabled} className={`side-nav-item ${active === item.id ? 'active' : ''}`} aria-current={active === item.id ? 'page' : undefined} onClick={() => { onNavigate(item.id); onClose() }}><Icon size={18} /><span>{item.label}</span></button> })}</nav></div><div className="sidebar-bottom"><div className="sidebar-tip"><Sparkles size={17} /><div><strong>{role === 'student' ? 'You are doing great.' : 'Keep the workspace clear.'}</strong><span>{role === 'student' ? 'One focused session is enough for today.' : 'Create and publish one focused assessment at a time.'}</span></div></div><div className="sidebar-profile">{student ? <StudentAvatar student={student} /> : <span className="admin-avatar admin-avatar-small">A</span>}<div><strong>{student ? displayName(student) : 'Administrator'}</strong><span>{student ? student.schoolId : 'Full access'}</span></div><button className="icon-button sidebar-more" disabled={disabled} aria-label="Account options" onClick={() => setMenuOpen((value) => !value)}><MoreHorizontal size={18} /></button>{menuOpen && !disabled && <div className="menu-popover sidebar-popover"><button onClick={() => { onNavigate(role === 'student' ? 'account' : 'students'); setMenuOpen(false) }}><UserRound size={14} /> {role === 'student' ? 'Account settings' : 'Manage students'}</button><button onClick={() => { setMenuOpen(false); onLogout() }}><LogOut size={14} /> Sign out</button></div>}</div><button className="logout-button" disabled={disabled} onClick={onLogout}><LogOut size={15} /> Sign out</button></div></aside></>
}

function StudentApp({ student, view, quiz, quizzes, scores, onNavigate, onOpenQuiz, onRefreshWorkspace, onStudentUpdate, onLogout, notify }: { student: Student; view: StudentView; quiz: Quiz | null; quizzes: Quiz[]; scores: ScoreRecord[]; onNavigate: (view: StudentView) => void; onOpenQuiz: (quiz: Quiz) => void; onRefreshWorkspace: () => Promise<void>; onStudentUpdate: (student: Student) => void; onLogout: () => void; notify: (toast: ToastMessage) => void }) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const answering = view === 'quiz'
  const title = view === 'dashboard' ? 'Your recovery plan' : view === 'quizzes' ? 'Your quizzes' : view === 'quiz' ? quiz?.title ?? 'Quiz workspace' : view === 'scores' ? 'Your scores' : 'Account settings'
  const eyebrow = view === 'dashboard' ? 'Student workspace' : view === 'quizzes' ? 'Assessment library' : view === 'quiz' ? quiz?.subject ?? DEFAULT_SUBJECT : view === 'scores' ? 'Progress history' : 'Personal settings'
  return <div className="app-shell"><Sidebar role="student" active={view} student={student} disabled={answering} mobileOpen={mobileOpen} onClose={() => setMobileOpen(false)} onNavigate={(next) => onNavigate(next as StudentView)} onLogout={onLogout} /><div className="app-main"><header className="topbar"><button className="mobile-menu-button" disabled={answering} onClick={() => setMobileOpen((value) => !value)} aria-label="Toggle navigation">{mobileOpen ? <X size={21} /> : <Menu size={21} />}</button><div className="topbar-heading"><span>{eyebrow}</span><h1>{title}</h1></div><div className="topbar-actions"><button className="icon-button topbar-help" disabled={answering} onClick={() => notify({ tone: 'info', title: 'Need help?', message: 'Contact your LateQuiz administrator.' })} aria-label="Help"><HelpCircle size={19} /></button><button className="avatar avatar-small" disabled={answering} aria-label="Open account" onClick={() => onNavigate('account')}>{student.avatar ? <img className="avatar-image" src={student.avatar} alt="" /> : initials(student)}</button></div></header><main className="page-content">{view === 'dashboard' && <StudentDashboard student={student} quizzes={quizzes} scores={scores} onOpenQuiz={onOpenQuiz} onNavigate={onNavigate} />}{view === 'quizzes' && <StudentQuizzesPage quizzes={quizzes} onOpenQuiz={onOpenQuiz} />}{view === 'quiz' && quiz && <StudentQuiz student={student} schoolId={student.schoolId} quiz={quiz} onExit={() => onNavigate('dashboard')} onRefreshWorkspace={onRefreshWorkspace} notify={notify} />}{view === 'scores' && <StudentScoresPage quizzes={quizzes} scores={scores} onOpenQuiz={onOpenQuiz} />}{view === 'account' && <StudentAccount student={student} onStudentUpdate={onStudentUpdate} notify={notify} />}</main></div></div>
}

function StudentDashboard({ student, quizzes, scores, onOpenQuiz, onNavigate }: { student: Student; quizzes: Quiz[]; scores: ScoreRecord[]; onOpenQuiz: (quiz: Quiz) => void; onNavigate: (view: StudentView) => void }) {
  const now = useCurrentTime()
  const [statsOpen, setStatsOpen] = useState(true)
  const assigned = quizzes.filter((quiz) => quiz.status !== 'locked')
  const completed = assigned.filter((quiz) => quiz.status === 'completed').length
  const finalized = scores.filter((score) => score.status !== 'reviewing')
  const average = finalized.length ? Math.round(finalized.reduce((sum, score) => sum + score.score, 0) / finalized.length) : 0
  const current = assigned.find((quiz) => quiz.status === 'ready')
  return <div className="content-stack"><section className="welcome-row"><div><div className="eyebrow eyebrow-accent"><Sparkles size={14} /> {currentDateLabel(now)}</div><h2>{currentGreeting(now)}, {displayName(student).split(' ')[0]}.</h2><p>Let&apos;s make a little progress toward finishing strong.</p></div><div className="term-pill"><span className="status-dot status-dot-green" /> Term recovery plan <ChevronDown size={15} /></div></section><section className={`student-overview-stats ${statsOpen ? 'is-open' : 'is-collapsed'}`}><div className="overview-stats-heading"><div><span className="eyebrow">At a glance</span><strong>Your progress</strong></div><button className="icon-button" onClick={() => setStatsOpen((value) => !value)} aria-expanded={statsOpen} aria-label={statsOpen ? 'Hide progress summary' : 'Show progress summary'}>{statsOpen ? <ChevronUp size={17} /> : <ChevronDown size={17} />}</button></div>{statsOpen && <div className="student-stat-grid"><StatCard icon={<Clock3 size={19} />} label="Assigned quizzes" value={String(assigned.length)} detail={assigned.length ? `${assigned.length - completed} remaining` : 'Nothing assigned yet'} tone="lavender" /><StatCard icon={<BarChart3 size={19} />} label="Average score" value={finalized.length ? String(average) : '--'} detail={finalized.length ? 'Normalized average' : 'No finalized results'} tone="mint" /><StatCard icon={<CheckCheck size={19} />} label="Completed" value={`${completed} / ${assigned.length}`} detail={assigned.length ? `${Math.max(assigned.length - completed, 0)} remaining` : 'No assigned quizzes'} tone="peach" /></div>}</section>{current && <section className="featured-quiz-card compact-featured-quiz"><div className="featured-card-top"><div className="subject-badge"><BookOpen size={15} /> {current.subject}</div><span className="quiz-time"><Clock3 size={14} /> {current.durationMinutes} min</span></div><div className="featured-card-body"><div><span className="eyebrow eyebrow-light">Next up</span><h3>{current.title}</h3><p>{current.description || 'Your next assigned recovery assessment.'}</p></div><span className="featured-icon"><BookOpen size={31} /></span></div><div className="featured-card-bottom"><span className="quiz-progress-copy"><strong>{current.questions}</strong> questions to go</span><button className="button button-white" onClick={() => onOpenQuiz(current)}>Take quiz <ArrowRight size={15} /></button></div></section>}<section><div className="section-heading"><div><span className="eyebrow">Current uploads</span><h3>Your quizzes</h3></div><button className="text-button with-icon" onClick={() => onNavigate('quizzes')}>Show all quizzes <ArrowUpRight size={15} /></button></div>{assigned.length ? <div className="quiz-list dashboard-quiz-list">{assigned.slice(0, 4).map((quiz) => <StudentQuizCardV2 key={quiz.id} quiz={quiz} onOpen={onOpenQuiz} />)}</div> : <section className="quiz-library-empty"><span className="empty-state-icon"><FolderKanban size={22} /></span><strong>No assigned quizzes yet</strong><span>Your administrator will place current assessments here.</span></section>}</section></div>
}

function StudentQuizzesPage({ quizzes, onOpenQuiz }: { quizzes: Quiz[]; onOpenQuiz: (quiz: Quiz) => void }) {
  const [filter, setFilter] = useState<'all' | 'mine'>('all')
  const [search, setSearch] = useState('')
  const filtered = quizzes.filter((quiz) => (filter === 'all' || quiz.status !== 'locked') && `${quiz.title} ${quiz.subject} ${quiz.description}`.toLowerCase().includes(search.toLowerCase()))
  return <div className="content-stack"><section className="page-intro-row admin-page-intro"><div><span className="eyebrow">Assessment library</span><h2>Find your next quiz.</h2><p>Browse current uploads or focus on the quizzes assigned to you.</p></div></section><div className="quiz-library-toolbar"><div className="filter-tabs student-quiz-tabs"><button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All quizzes<span>{quizzes.length}</span></button><button className={filter === 'mine' ? 'active' : ''} onClick={() => setFilter('mine')}>My quizzes<span>{quizzes.filter((quiz) => quiz.status !== 'locked').length}</span></button></div><div className="search-wrap"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search quizzes" /></div></div>{filtered.length ? <div className="student-quiz-grid">{filtered.map((quiz) => <StudentQuizCardV2 key={quiz.id} quiz={quiz} onOpen={onOpenQuiz} />)}</div> : <section className="quiz-library-empty"><span className="empty-state-icon"><FolderKanban size={22} /></span><strong>No quizzes found</strong><span>Try another tab or search term.</span></section>}</div>
}

function StudentQuizCardV2({ quiz, onOpen }: { quiz: Quiz; onOpen: (quiz: Quiz) => void }) {
  const locked = quiz.status === 'locked'
  const complete = quiz.status === 'completed'
  const awaitingReview = quiz.status === 'in-review'
  return <article className={`quiz-card quiz-card-${quizCardTone(quiz.subject)} ${locked ? 'quiz-card-locked' : ''}`}><div className="quiz-card-icon"><BookOpen size={19} /></div><div className="quiz-card-content"><div className="quiz-card-meta"><span>{quiz.subject}</span>{complete ? <StatusBadge tone="success">Completed</StatusBadge> : awaitingReview ? <StatusBadge tone="warning">Awaiting review</StatusBadge> : locked ? <StatusBadge tone="neutral" icon={<LockKeyhole size={11} />}>Not assigned</StatusBadge> : <StatusBadge tone="warning">Ready</StatusBadge>}</div><h3>{quiz.title}</h3><p className="quiz-card-description">{quiz.description || 'No instructions added yet.'}</p><div className="quiz-card-details"><span><ListChecks size={14} /> {quiz.questions} questions</span><span><Clock3 size={14} /> {quiz.durationMinutes} min</span></div></div>{complete && <div className="card-score"><strong>{quiz.score !== undefined ? `${quiz.score}%` : quiz.earnedPoints !== undefined && quiz.possiblePoints !== undefined ? `${quiz.earnedPoints} / ${quiz.possiblePoints}` : '--'}</strong><span>{quiz.score !== undefined ? `${quiz.earnedPoints ?? 0} / ${quiz.possiblePoints ?? quiz.points} pts` : 'score'}</span></div>}<button className={`icon-button card-arrow ${locked ? 'is-locked' : ''}`} onClick={() => onOpen(quiz)} aria-label={locked ? 'Quiz not assigned' : `Open ${quiz.title}`}>{locked ? <LockKeyhole size={17} /> : <ArrowUpRight size={18} />}</button></article>
}

function StudentQuiz({ student, schoolId, quiz, onExit, onRefreshWorkspace, notify }: { student: Student; schoolId: string; quiz: Quiz; onExit: () => void; onRefreshWorkspace: () => Promise<void>; notify: (toast: ToastMessage) => void }) {
  const questions = quiz.questionsList ?? []
  const [currentIndex, setCurrentIndex] = useState(0)
  const [isReview, setIsReview] = useState(false)
  const [isSubmitted, setIsSubmitted] = useState(false)
  const [attemptId, setAttemptId] = useState<string | null>(null)
  const [expiresAt, setExpiresAt] = useState<string | null>(quiz.expiresAt ?? null)
  const [secondsLeft, setSecondsLeft] = useState(() => quiz.expiresAt ? Math.max(0, Math.ceil((new Date(quiz.expiresAt).getTime() - Date.now()) / 1000)) : quiz.durationMinutes * 60)
  const [answers, setAnswers] = useState<Record<string, string>>(() => Object.fromEntries(questions.map((question) => [question.id, question.response ?? ''])))
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submissionResult, setSubmissionResult] = useState<AttemptSubmissionResult | null>(null)
  const currentQuestion = questions[currentIndex]
  const answeredCount = Object.values(answers).filter(Boolean).length
  const progress = questions.length ? Math.round((answeredCount / questions.length) * 100) : 0

  useEffect(() => {
    if (quiz.status !== 'ready') return
    let active = true
    startAttempt(quiz.id, schoolId).then((result) => {
      if (!active) return
      if (result.error) return notify({ tone: 'warning', title: 'Unable to start attempt', message: result.error.message })
      setAttemptId(result.attemptId)
      if (result.expiresAt) {
        setExpiresAt(result.expiresAt)
        setSecondsLeft(Math.max(0, Math.ceil((new Date(result.expiresAt).getTime() - Date.now()) / 1000)))
      }
    }).catch((error: Error) => { if (active) notify({ tone: 'warning', title: 'Unable to start attempt', message: error.message }) })
    return () => { active = false }
  }, [quiz.id, quiz.status, schoolId, notify])

  useEffect(() => {
    if (!attemptId || isSubmitted) return
    const timeout = window.setTimeout(async () => {
      const result = await saveAttemptAnswers(attemptId, questions, answers)
      if (result.error) notify({ tone: 'warning', title: 'Answer autosave failed', message: result.error.message })
    }, 550)
    return () => window.clearTimeout(timeout)
  }, [answers, attemptId, isSubmitted, notify, questions])

  useEffect(() => {
    if (!expiresAt || isSubmitted) return
    const update = () => setSecondsLeft(Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000)))
    update()
    const timer = window.setInterval(update, 1000)
    return () => window.clearInterval(timer)
  }, [expiresAt, isSubmitted])

  const finishQuiz = async () => {
    if (isSubmitting) return
    if (!attemptId) return notify({ tone: 'warning', title: 'Attempt is not ready', message: 'Wait for the quiz attempt to connect before submitting.' })
    setIsSubmitting(true)
    const saveResult = await saveAttemptAnswers(attemptId, questions, answers)
    if (saveResult.error) {
      notify({ tone: 'warning', title: 'Could not save all answers', message: saveResult.error.message })
      setIsSubmitting(false)
      return
    }
    const submitResult = await submitAttempt(attemptId)
    if (submitResult.error) {
      notify({ tone: 'warning', title: 'Could not submit quiz', message: submitResult.error.message })
      setIsSubmitting(false)
      return
    }
    setSubmissionResult(submitResult.data ?? null)
    setIsSubmitted(true)
    setIsSubmitting(false)
    void onRefreshWorkspace()
  }

  useEffect(() => {
    if (secondsLeft === 0 && !isSubmitted && attemptId) {
      void finishQuiz()
      notify({ tone: 'warning', title: 'Time is up', message: 'Your saved answers were submitted automatically.' })
    }
  }, [secondsLeft, isSubmitted, attemptId])

  if (quiz.status === 'completed' || quiz.status === 'in-review') return <section className="quiz-result-page"><button className="back-link" onClick={onExit}><ArrowLeft size={16} /> Back to quizzes</button><div className="result-card"><div className="result-burst"><CheckCircle2 size={30} /></div><span className="eyebrow eyebrow-accent">{quiz.status === 'completed' ? 'Completed quiz' : 'Awaiting review'}</span><h2>{quiz.status === 'completed' ? `You scored ${quiz.earnedPoints ?? 0} / ${quiz.possiblePoints ?? quiz.points} pts.` : 'Your answers are under review.'}</h2><p>This quiz is read-only because the attempt has already been submitted.</p><button className="button button-primary" onClick={onExit}>Return to quizzes <ArrowRight size={16} /></button></div></section>
  if (!currentQuestion) return <section className="quiz-result-page"><button className="back-link" onClick={onExit}><ArrowLeft size={16} /> Back to quizzes</button><div className="result-card"><div className="result-burst"><BookOpen size={28} /></div><h2>This quiz has no questions yet.</h2><p>Ask your administrator to finish the quiz before starting it.</p></div></section>
  if (isSubmitted) return <section className="quiz-result-page"><button className="back-link" onClick={onExit}><ArrowLeft size={16} /> Back to quizzes</button><div className="result-card"><div className="result-burst"><CheckCircle2 size={30} /></div><span className="eyebrow eyebrow-accent">Submission received</span><h2>Nice work, {displayName(student).split(' ')[0]}.</h2><p>Your answers are saved. Written and uploaded items remain available for administrator review.</p><div className="result-summary"><div><span>Auto-graded score</span><strong>{submissionResult ? `${submissionResult.earned_points} / ${submissionResult.possible_points} pts` : '--'}</strong></div><div><span>Manual review</span><strong>{submissionResult?.manual_items ? `${submissionResult.manual_items} pending` : 'None pending'}</strong></div><div><span>Submitted</span><strong>{submissionResult?.expired ? 'Time expired' : 'Just now'}</strong></div></div><button className="button button-primary" onClick={onExit}>Return to quizzes <ArrowRight size={16} /></button></div></section>

  const formatTime = `${Math.floor(secondsLeft / 60).toString().padStart(2, '0')}:${(secondsLeft % 60).toString().padStart(2, '0')}`
  const setAnswer = (value: string) => setAnswers((current) => ({ ...current, [currentQuestion.id]: value }))
  return <div className="quiz-runner"><div className="quiz-runner-top"><button className="back-link" onClick={onExit}><ArrowLeft size={16} /> Exit quiz</button><div className={`timer-pill ${secondsLeft < 300 ? 'timer-warning' : ''}`}><Clock3 size={16} /><span>{formatTime}</span><small>remaining</small></div></div><div className="quiz-runner-layout"><aside className="question-sidebar"><div className="question-sidebar-heading"><div><span className="eyebrow">Question map</span><strong>{answeredCount} of {questions.length} answered</strong></div><span className="question-percent">{progress}%</span></div><div className="progress-track"><span style={{ width: `${progress}%` }} /></div><div className="question-grid">{questions.map((question, index) => <button key={question.id} className={`${index === currentIndex ? 'current ' : ''}${answers[question.id] ? 'answered' : ''}`} onClick={() => { setCurrentIndex(index); setIsReview(false) }}>{index + 1}{answers[question.id] && <Check size={11} />}</button>)}</div></aside><section className="question-panel">{isReview ? <QuizReview answers={answers} questions={questions} onJump={(index) => { setCurrentIndex(index); setIsReview(false) }} onBack={() => setIsReview(false)} onSubmit={() => void finishQuiz()} /> : <><div className="question-panel-heading"><div><span className="question-number">Question {currentIndex + 1} <span>of {questions.length}</span></span><StatusBadge tone={currentQuestion.requiresReview ? 'purple' : 'blue'}>{currentQuestion.type === 'multiple-choice' ? 'Multiple choice' : currentQuestion.type === 'identification' ? 'Identification' : currentQuestion.type === 'essay' ? 'Essay' : 'File upload'}</StatusBadge></div><span className="question-points">{currentQuestion.points} pts</span></div><div className="question-copy"><h2>{currentQuestion.prompt}</h2><p>Answer carefully. Your progress saves automatically.</p></div><QuestionInput question={currentQuestion} value={answers[currentQuestion.id] ?? ''} onChange={setAnswer} /><div className="question-footer"><span className="muted-label">{answeredCount} of {questions.length} answered</span><div className="question-nav-buttons"><button className="button button-secondary previous-button" disabled={currentIndex === 0} onClick={() => setCurrentIndex((index) => Math.max(0, index - 1))}><ArrowLeft size={15} /> Previous</button>{currentIndex < questions.length - 1 ? <button className="button button-primary" onClick={() => setCurrentIndex((index) => Math.min(questions.length - 1, index + 1))}>Next <ArrowRight size={15} /></button> : <button className="button button-primary" onClick={() => setIsReview(true)}>Review answers <ClipboardCheck size={15} /></button>}</div></div></>}</section></div></div>
}

function QuizReview({ answers, questions, onJump, onBack, onSubmit }: { answers: Record<string, string>; questions: Question[]; onJump: (index: number) => void; onBack: () => void; onSubmit: () => void }) {
  const [confirmSubmit, setConfirmSubmit] = useState(false)
  const unanswered = questions.filter((question) => !answers[question.id]).length
  return <div className="review-panel"><div className="review-heading"><span className="eyebrow eyebrow-accent">Final check</span><h2>Review every answer</h2><p>Each question is shown in full. Your response appears beneath it.</p></div>{unanswered > 0 && <div className="review-alert"><CircleAlert size={18} /><span><strong>{unanswered} unanswered.</strong> You can still go back.</span></div>}<div className="review-list review-question-list">{questions.map((question, index) => <article key={question.id} className="review-question-card"><div className="review-question-heading"><span className={`review-number ${answers[question.id] ? 'answered' : ''}`}>{answers[question.id] ? <Check size={14} /> : index + 1}</span><div><span className="eyebrow">Question {index + 1} · {question.points} pts</span><h3>{question.prompt}</h3></div><button className="button button-ghost" onClick={() => onJump(index)}>Edit answer</button></div><div className={`review-answer ${answers[question.id] ? '' : 'empty'}`}><span>Your answer</span><strong>{answers[question.id] || 'No answer yet'}</strong></div></article>)}</div><div className="review-actions"><button className="button button-secondary" onClick={onBack}><ArrowLeft size={16} /> Keep answering</button><button className="button button-primary" onClick={() => setConfirmSubmit(true)}>Submit quiz <Send size={15} /></button></div>{confirmSubmit && <ConfirmModal title="Submit your quiz?" message={unanswered ? `${unanswered} question${unanswered === 1 ? ' is' : 's are'} unanswered. You cannot change answers after submission.` : 'You will not be able to change your answers after submission.'} confirmLabel="Submit quiz" onCancel={() => setConfirmSubmit(false)} onConfirm={() => { setConfirmSubmit(false); onSubmit() }} />}</div>
}

function StudentScoresPage({ quizzes, scores, onOpenQuiz }: { quizzes: Quiz[]; scores: ScoreRecord[]; onOpenQuiz: (quiz: Quiz) => void }) {
  const average = scores.length ? Math.round(scores.reduce((sum, score) => sum + score.score, 0) / scores.length) : 0
  const nextQuiz = quizzes.find((quiz) => quiz.status === 'ready')
  return <div className="content-stack"><section className="page-intro-row"><div><span className="eyebrow">Progress history</span><h2>A record of your effort.</h2><p>Every attempt is a useful signal. Keep building from here.</p></div><div className="score-summary-chip"><span className="score-summary-ring">{scores.length ? average : '--'}</span><div><strong>Current average</strong><span>{scores.length ? `Across ${scores.length} finalized results` : 'No finalized results yet'}</span></div></div></section><section className="score-overview-grid"><div className="score-overview-card"><div className="section-heading"><div><span className="eyebrow">Term performance</span><h3>{scores.length ? 'Your recorded scores' : 'Your first result starts here'}</h3></div></div><div className="score-chart"><div className="chart-y-labels"><span>100</span><span>75</span><span>50</span><span>25</span><span>0</span></div><div className="chart-area"><div className="chart-grid-lines"><i /><i /><i /><i /><i /></div><div className="chart-bars">{(scores.length ? scores.slice(-6).map((score) => score.score) : [0]).map((value, index) => <span key={index} className={index === (scores.length ? Math.min(scores.length, 6) - 1 : 0) ? 'bar-current' : ''} style={{ height: `${Math.max(value, 8)}%` }}><b>{value}</b></span>)}</div><div className="chart-x-labels"><span>Recent</span><span>Results</span></div></div></div></div><div className="score-overview-card goal-card"><div className="goal-icon"><Target size={20} /></div><span className="eyebrow">Your term goal</span><h3>Pass every recovery quiz</h3><p>{nextQuiz ? 'You have an assigned quiz ready for your next focused session.' : 'Your current recovery plan is complete or waiting for an assignment.'}</p><div className="goal-progress"><div><span>{scores.filter((score) => score.status === 'passed').length} passed</span><strong>{scores.length ? `${average} avg` : '--'}</strong></div><div className="progress-track"><span style={{ width: `${Math.min(average, 100)}%` }} /></div></div></div></section><section className="table-card"><div className="table-card-heading"><div><span className="eyebrow">Score history</span><h3>{scores.length ? 'Finalized results' : 'No finalized scores yet'}</h3></div>{nextQuiz && <button className="button button-primary button-small" onClick={() => onOpenQuiz(nextQuiz)}>Take next quiz <ArrowRight size={14} /></button>}</div>{scores.length ? <div className="score-table"><div className="score-table-head"><span>Assessment</span><span>Date</span><span>Score</span><span>Status</span><span /></div>{scores.map((record) => <ScoreRowV2 key={record.id} record={record} />)}</div> : <div className="empty-state"><BarChart3 size={24} /><strong>Your results will appear here</strong><span>Complete an assigned quiz to start building your history.</span></div>}</section></div>
}

function ScoreRowV2({ record }: { record: ScoreRecord }) {
  return <div className="score-table-row"><div className="table-assessment"><span className="table-assessment-icon"><BookOpen size={16} /></span><div><strong>{record.title}</strong><span>{record.subject}</span></div></div><span className="table-date">{record.date}</span><div className="table-score"><strong>{record.earnedPoints !== undefined && record.possiblePoints !== undefined ? `${record.earnedPoints} / ${record.possiblePoints}` : record.score}</strong><span>points</span></div><StatusBadge tone={record.status === 'passed' ? 'success' : record.status === 'reviewing' ? 'warning' : 'danger'}>{record.status === 'passed' ? 'Passed' : record.status === 'reviewing' ? 'Under review' : 'Needs retake'}</StatusBadge><span /></div>
}

function StudentAccount({ student, onStudentUpdate = () => undefined, notify }: { student: Student; onStudentUpdate?: (student: Student) => void; notify: (toast: ToastMessage) => void }) {
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [isAvatarSaving, setIsAvatarSaving] = useState(false)
  const avatarInput = useRef<HTMLInputElement>(null)
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (password.length < 8 || password !== confirmation) return notify({ tone: 'warning', title: 'Check your new password', message: 'Use at least 8 characters and make both fields match.' })
    setIsSaving(true)
    const result = await changePassword(password)
    setIsSaving(false)
    if (result.error) return notify({ tone: 'warning', title: 'Password could not be changed', message: result.error.message })
    setPassword('')
    setConfirmation('')
    notify({ tone: 'success', title: 'Password changed', message: 'Your account is protected with the new password.' })
  }
  const chooseAvatar = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) return notify({ tone: 'warning', title: 'Choose an image file' })
    if (file.size > 5 * 1024 * 1024) return notify({ tone: 'warning', title: 'Image is too large', message: 'Profile pictures must be 5 MB or smaller.' })
    setIsAvatarSaving(true)
    const result = await uploadAvatar(file)
    setIsAvatarSaving(false)
    if (result.error) return notify({ tone: 'warning', title: 'Profile picture could not be saved', message: result.error.message })
    onStudentUpdate({ ...student, avatar: result.url ?? undefined, avatarPath: result.path ?? undefined })
    notify({ tone: 'success', title: 'Profile picture updated' })
  }
  const clearAvatar = async () => {
    setIsAvatarSaving(true)
    const result = await removeAvatar()
    setIsAvatarSaving(false)
    if (result.error) return notify({ tone: 'warning', title: 'Profile picture could not be removed', message: result.error.message })
    onStudentUpdate({ ...student, avatar: undefined, avatarPath: undefined })
    notify({ tone: 'success', title: 'Profile picture removed' })
  }
  return <div className="content-stack account-page"><section className="page-intro-row"><div><span className="eyebrow">Personal settings</span><h2>Your account, your way.</h2><p>Your name and school ID are managed by the administrator.</p></div><span className="account-secure"><ShieldCheck size={15} /> Account protected</span></section><div className="account-layout"><section className="form-card"><div className="form-card-heading"><div><span className="eyebrow">Profile details</span><h3>{displayName(student)}</h3></div><button className="avatar avatar-edit" disabled={isAvatarSaving} onClick={() => avatarInput.current?.click()} aria-label="Change profile picture"><StudentAvatar student={student} className="avatar avatar-edit-inner" /><span><ImagePlus size={11} /></span></button></div><input ref={avatarInput} className="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void chooseAvatar(event)} /><div className="avatar-actions"><button className="button button-secondary button-small" disabled={isAvatarSaving} onClick={() => avatarInput.current?.click()}>{isAvatarSaving ? 'Saving...' : 'Choose picture'} <Upload size={13} /></button>{student.avatar && <button className="button button-ghost button-small" disabled={isAvatarSaving} onClick={() => void clearAvatar()}><Trash2 size={13} /> Remove</button>}</div><div className="settings-fields"><div><label className="field-label">School ID</label><div className="readonly-input"><ShieldCheck size={16} /> {student.schoolId}<span>Verified</span></div></div><div className="info-callout"><CircleAlert size={17} /><span>School ID and profile names are used for quiz assignments and are managed by your administrator.</span></div></div></section><section className="form-card security-card"><div className="form-card-heading"><div><span className="eyebrow">Security</span><h3>Change password</h3></div><LockKeyhole size={20} className="muted-icon" /></div><form className="settings-fields" onSubmit={save}><div><label className="field-label" htmlFor="account-password">New password</label><input className="form-input" id="account-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></div><div><label className="field-label" htmlFor="account-password-confirm">Confirm password</label><input className="form-input" id="account-password-confirm" type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></div><button className="button button-primary" disabled={isSaving} type="submit">{isSaving ? 'Saving...' : 'Update password'} <CheckCheck size={16} /></button></form></section></div></div>
}

function AdminQuizzes({ quizzes, onStartBuilder, onRefresh, notify }: { quizzes: Quiz[]; onStartBuilder: (isNew: boolean, quiz?: Quiz) => void; onRefresh: () => Promise<void>; notify: (toast: ToastMessage) => void }) {
  const [filter, setFilter] = useState('All quizzes')
  const [search, setSearch] = useState('')
  const [assigningQuiz, setAssigningQuiz] = useState<Quiz | null>(null)
  const filters = ['All quizzes', 'Published', 'Drafts', 'Archived']
  const filtered = quizzes.filter((quiz) => {
    const matches = filter === 'All quizzes' || filter === 'Published' && quiz.status === 'ready' || filter === 'Drafts' && quiz.status === 'draft' || filter === 'Archived' && quiz.status === 'archived'
    return matches && `${quiz.title} ${quiz.subject} ${quiz.description}`.toLowerCase().includes(search.toLowerCase())
  })
  return <div className="content-stack"><section className="page-intro-row admin-page-intro"><div><span className="eyebrow">Assessment library</span><h2>All quizzes, one clear workspace.</h2><p>Create, review, publish, and assign recovery assessments from one place.</p></div><button className="button button-primary" onClick={() => onStartBuilder(true)}><Plus size={17} /> New quiz</button></section><div className="quiz-library-toolbar"><div className="filter-tabs">{filters.map((item) => <button key={item} className={filter === item ? 'active' : ''} onClick={() => setFilter(item)}>{item}<span>{item === 'All quizzes' ? quizzes.length : item === 'Published' ? quizzes.filter((quiz) => quiz.status === 'ready').length : item === 'Drafts' ? quizzes.filter((quiz) => quiz.status === 'draft').length : quizzes.filter((quiz) => quiz.status === 'archived').length}</span></button>)}</div><div className="search-wrap"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search quizzes" /></div></div>{filtered.length ? <div className="admin-quiz-grid">{filtered.map((quiz) => <AdminQuizCard key={quiz.id} quiz={quiz} onEdit={() => onStartBuilder(false, quiz)} onAssign={() => setAssigningQuiz(quiz)} onRefresh={onRefresh} notify={notify} />)}<button className="new-quiz-card" onClick={() => onStartBuilder(true)}><span><Plus size={21} /></span><strong>Create another quiz</strong><small>Start with a clean question set</small></button></div> : <section className="quiz-library-empty"><span className="empty-state-icon"><FolderKanban size={22} /></span><strong>{quizzes.length ? 'No quizzes match this filter' : 'No quizzes yet'}</strong><span>{quizzes.length ? 'Try another filter or search term.' : 'Create your first quiz to start building the library.'}</span><button className="button button-primary" onClick={() => onStartBuilder(true)}><Plus size={15} /> Create quiz</button></section>}{assigningQuiz && <AssignQuizModal quiz={assigningQuiz} onClose={() => setAssigningQuiz(null)} onSaved={async () => { setAssigningQuiz(null); await onRefresh() }} notify={notify} />}</div>
}

function AdminQuizCard({ quiz, onEdit, onAssign, onRefresh, notify }: { quiz: Quiz; onEdit: () => void; onAssign: () => void; onRefresh: () => Promise<void>; notify: (toast: ToastMessage) => void }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const statusTone = quiz.status === 'ready' ? 'success' : quiz.status === 'draft' ? 'warning' : 'neutral'
  const statusLabel = quiz.status === 'ready' ? 'Published' : quiz.status === 'draft' ? 'Draft' : 'Archived'
  const changeStatus = async (status: 'draft' | 'published' | 'archived') => {
    const result = await setQuizStatus(quiz.id, status)
    if (result.error) notify({ tone: 'warning', title: 'Quiz status could not change', message: result.error.message })
    else { notify({ tone: 'success', title: status === 'published' ? 'Quiz published' : status === 'archived' ? 'Quiz archived' : 'Quiz moved to drafts' }); await onRefresh() }
    setMenuOpen(false)
  }
  const remove = async () => {
    setIsDeleting(true)
    const result = await deleteQuiz(quiz.id)
    setIsDeleting(false)
    if (result.error) return notify({ tone: 'warning', title: 'Quiz could not be deleted', message: result.error.message })
    setConfirmDelete(false)
    notify({ tone: 'success', title: result.result === 'archived' ? 'Quiz archived safely' : 'Quiz deleted', message: result.result === 'archived' ? 'Its historical attempts were preserved.' : undefined })
    await onRefresh()
  }
  return <article className={`admin-quiz-card admin-quiz-card-${quizCardTone(quiz.subject)}`}><div className="admin-quiz-card-top"><div className={`admin-quiz-art art-${quizCardTone(quiz.subject)}`}><BookOpen size={22} /></div><div className="menu-anchor"><button className="icon-button" aria-label="More quiz actions" onClick={() => setMenuOpen((value) => !value)}><MoreHorizontal size={18} /></button>{menuOpen && <div className="menu-popover quiz-popover"><button onClick={onEdit}><Pencil size={14} /> Edit quiz</button><button onClick={onAssign}><UsersRound size={14} /> Assign students</button>{quiz.status === 'ready' ? <button onClick={() => void changeStatus('draft')}><FileText size={14} /> Move to drafts</button> : quiz.status === 'draft' ? <button onClick={() => void changeStatus('published')}><Send size={14} /> Publish quiz</button> : <button onClick={() => void changeStatus('draft')}><FolderKanban size={14} /> Restore draft</button>}<button className="danger-menu-item" onClick={() => { setMenuOpen(false); setConfirmDelete(true) }}><Trash2 size={14} /> Delete quiz</button></div>}</div></div><div className="admin-quiz-card-copy"><div className="quiz-card-meta"><span>{quiz.subject}</span><StatusBadge tone={statusTone}>{statusLabel}</StatusBadge></div><h3>{quiz.title}</h3><p>{quiz.description || 'No instructions added yet.'}</p></div><div className="admin-quiz-card-stats"><span><ListChecks size={14} /> {quiz.questions} questions</span><span><UsersRound size={14} /> {quiz.assignedCount ?? 0} assigned</span><span><Clock3 size={14} /> {quiz.durationMinutes} min</span></div><div className="admin-quiz-card-actions"><button className="button button-secondary" onClick={onEdit}><Pencil size={14} /> Edit quiz</button><button className="button button-primary" onClick={onAssign}><UsersRound size={14} /> Assign</button></div>{confirmDelete && <ConfirmModal title={`Delete ${quiz.title}?`} message="Drafts without attempts are permanently deleted. Quizzes with history are archived so student scores remain safe." confirmLabel={isDeleting ? 'Deleting...' : 'Delete quiz'} onCancel={() => setConfirmDelete(false)} onConfirm={() => void remove()} />}</article>
}

function AssignQuizModal({ quiz, onClose, onSaved, notify }: { quiz: Quiz; onClose: () => void; onSaved: () => Promise<void>; notify: (toast: ToastMessage) => void }) {
  const [students, setStudents] = useState<Student[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [initialSelected, setInitialSelected] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [attemptLimit, setAttemptLimit] = useState(1)
  const [isSaving, setIsSaving] = useState(false)
  const [isLoaded, setIsLoaded] = useState(false)
  const [confirmUnassign, setConfirmUnassign] = useState(false)
  useEffect(() => {
    Promise.all([loadAdminRoster(), loadQuizAssignments(quiz.id)]).then(([roster, assignmentResult]) => {
      if (assignmentResult.error) throw assignmentResult.error
      const activeIds = assignmentResult.data.map((assignment) => assignment.school_id)
      setStudents(roster)
      setSelected(activeIds)
      setInitialSelected(activeIds)
      if (assignmentResult.data[0]?.attempt_limit) setAttemptLimit(Number(assignmentResult.data[0].attempt_limit))
      setIsLoaded(true)
    }).catch((error: Error) => notify({ tone: 'warning', title: 'Assignment data could not load', message: error.message }))
  }, [quiz.id, notify])
  const visible = sortStudents(students.filter((student) => `${student.schoolId} ${student.firstNames} ${student.lastName}`.toLowerCase().includes(search.toLowerCase()) && student.active !== false))
  const allSelected = visible.length > 0 && visible.every((student) => selected.includes(student.schoolId))
  const toggleAll = () => setSelected(allSelected ? selected.filter((id) => !visible.some((student) => student.schoolId === id)) : [...new Set([...selected, ...visible.map((student) => student.schoolId)])])
  const save = async () => {
    if (!isLoaded) return
    const removed = initialSelected.filter((schoolId) => !selected.includes(schoolId))
    if (removed.length && !confirmUnassign) {
      setConfirmUnassign(true)
      return
    }
    setIsSaving(true)
    const result = await assignQuiz(quiz.id, selected, attemptLimit)
    setIsSaving(false)
    if (result.error) return notify({ tone: 'warning', title: 'Assignment changes failed', message: result.error.message })
    setConfirmUnassign(false)
    notify({ tone: 'success', title: 'Assignments updated', message: selected.length ? `${selected.length} student${selected.length === 1 ? '' : 's'} can access this quiz.` : 'All students were unassigned from this quiz.' })
    await onSaved()
  }
  return <div className="modal-overlay" onClick={onClose}><section className="assignment-modal" onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><span className="eyebrow eyebrow-accent">Assign quiz</span><h2>{quiz.title}</h2><p>Select students. Uncheck a student to unassign them.</p></div><button className="icon-button" onClick={onClose} aria-label="Close assignment"><X size={18} /></button></div><div className="assignment-modal-toolbar"><div className="search-wrap"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search students" /></div><label className="attempt-select">Attempts<select value={attemptLimit} onChange={(event) => setAttemptLimit(Number(event.target.value))}><option value="1">1 attempt</option><option value="2">2 attempts</option><option value="3">3 attempts</option><option value="5">5 attempts</option></select></label></div><div className="assignment-select-all"><label className="table-check"><input type="checkbox" checked={allSelected} onChange={toggleAll} /><span className="custom-check"><Check size={12} /></span></label><span>Select all visible students</span><strong>{selected.length} selected</strong></div><div className="assignment-student-list">{visible.map((student) => <label className={`assignment-student-row ${selected.includes(student.schoolId) ? 'selected' : ''}`} key={student.schoolId}><span className="table-check"><input type="checkbox" checked={selected.includes(student.schoolId)} onChange={() => setSelected((items) => items.includes(student.schoolId) ? items.filter((id) => id !== student.schoolId) : [...items, student.schoolId])} /><span className="custom-check"><Check size={12} /></span></span><StudentAvatar student={student} className="avatar avatar-tiny avatar-mint" /><span><strong>{displayName(student)}</strong><small>{student.schoolId}</small></span><span className="assignment-count">{student.assignmentCount ?? 0} assigned</span></label>)}{!visible.length && <div className="empty-state"><UsersRound size={22} /><strong>No active students found</strong><span>Try another search or add students to the roster.</span></div>}</div><div className="modal-actions"><button className="button button-secondary" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={isSaving} onClick={() => void save()}>{isSaving ? 'Saving...' : 'Save assignments'} <Check size={15} /></button></div>{confirmUnassign && <ConfirmModal title="Unassign selected students?" message="Students you unchecked will lose access. Any in-progress attempts for them will be cancelled." confirmLabel="Unassign and save" onCancel={() => setConfirmUnassign(false)} onConfirm={() => void save()} />}</section></div>
}

function AdminApp({ view, quizzes, builderQuiz, isBuilderNew, onNavigate, onStartBuilder, onRefreshQuizzes, onLogout, notify }: { view: AdminView; quizzes: Quiz[]; builderQuiz: Quiz | null; isBuilderNew: boolean; onNavigate: (view: AdminView) => void; onStartBuilder: (isNew: boolean, quiz?: Quiz) => void; onRefreshQuizzes: () => Promise<void>; onLogout: () => void; notify: (toast: ToastMessage) => void }) {
  const allowNextBuilderExit = useRef(false)
  const guardedNavigate = (next: AdminView) => {
    if (allowNextBuilderExit.current) {
      allowNextBuilderExit.current = false
      onNavigate(next)
      return
    }
    if (view === 'builder' && next === 'quizzes' && !window.confirm('Discard unsaved quiz changes and return to the library?')) return
    onNavigate(next)
  }
  const refreshQuizzes = async () => {
    if (view === 'builder') allowNextBuilderExit.current = true
    await onRefreshQuizzes()
  }
  return <LegacyAdminApp view={view} quizzes={quizzes} builderQuiz={builderQuiz} isBuilderNew={isBuilderNew} onNavigate={guardedNavigate} onStartBuilder={onStartBuilder} onRefreshQuizzes={refreshQuizzes} onLogout={onLogout} notify={notify} />
}
