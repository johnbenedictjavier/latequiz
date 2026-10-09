import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { Question, QuizPart } from '../types'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

type TextItem = {
  str: string
  transform: number[]
}

export type ImportedQuizDraft = {
  title: string
  description: string
  parts: QuizPart[]
  warnings: string[]
}

function localId(prefix: string, index: number) {
  return `${prefix}-${index + 1}-${Math.random().toString(36).slice(2, 8)}`
}

function cleanLine(value: string) {
  return value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
}

function isFooter(line: string) {
  return /^quiz with answer keys\s+\d+$/i.test(line)
}

function isPartHeading(line: string) {
  return /^part\s+[a-z0-9ivx]+\s*[-:]/i.test(line)
}

function isQuestionStart(line: string) {
  return /^(\d+)[.)]\s+/.test(line)
}

function questionText(line: string) {
  return line.replace(/^\d+[.)]\s+/, '').trim()
}

function isAnswerLine(line: string) {
  return /^answer\s*:/i.test(line)
}

function answerText(line: string) {
  return line.replace(/^answer\s*:\s*/i, '').trim()
}

function isOptionLine(line: string) {
  return /^\(?[A-H]\)?[.)\-:]\s+.+/i.test(line)
}

function optionText(line: string) {
  return line.replace(/^\(?[A-H]\)?[.)\-:]\s+/, '').trim()
}

function isTrueFalsePart(title: string) {
  return /true\s*\/\s*false|true\s+or\s+false/i.test(title)
}

function isMultipleChoicePart(title: string) {
  return /multiple[- ]choice|multiple choice|choose from the choices/i.test(title)
}

function normalizeBooleanAnswer(value: string) {
  const normalized = value.toLowerCase().replace(/[.\s]+$/, '')
  if (normalized === 'true' || normalized === 't') return 'True'
  if (normalized === 'false' || normalized === 'f') return 'False'
  return value
}

function makeQuestion(
  part: QuizPart,
  prompt: string,
  answer: string,
  options: string[],
  index: number,
): Question {
  const trueFalse = isTrueFalsePart(part.title)
  const multipleChoice = trueFalse || options.length > 1 || isMultipleChoicePart(part.title)
  const finalOptions = trueFalse ? ['True', 'False'] : options
  let finalAnswer = trueFalse ? normalizeBooleanAnswer(answer) : answer

  if (multipleChoice && /^[A-H]$/i.test(finalAnswer) && finalOptions.length) {
    const optionIndex = finalAnswer.toUpperCase().charCodeAt(0) - 65
    finalAnswer = finalOptions[optionIndex] ?? finalAnswer
  }

  return {
    id: localId(`imported-question-${part.position}`, index),
    type: multipleChoice ? 'multiple-choice' : 'identification',
    prompt: prompt.trim(),
    points: 1,
    options: multipleChoice ? finalOptions : undefined,
    answer: finalAnswer,
    requiresReview: false,
    partId: part.id,
    partPosition: index + 1,
  }
}

export function parseQuizText(text: string, fileName = 'imported PDF'): ImportedQuizDraft {
  const lines = text
    .split(/\r?\n/)
    .map(cleanLine)
    .filter((line) => line && !isFooter(line))

  const title = lines.find((line) => !/^page\s+\d+\s*(of\s*\d+)?$/i.test(line)) ?? fileName.replace(/\.pdf$/i, '')
  const parts: QuizPart[] = []
  const warnings: string[] = []
  let currentPart: QuizPart | null = null
  let currentQuestion: { prompt: string[]; answer: string; options: string[] } | null = null
  let afterAnswer = false
  let questionIndex = 0

  const finishQuestion = () => {
    if (!currentPart || !currentQuestion) return
    const prompt = currentQuestion.prompt.join(' ').trim()
    if (!prompt) {
      warnings.push(`${currentPart.title}: question ${currentPart.questions.length + 1} has no prompt.`)
    } else if (!currentQuestion.answer) {
      warnings.push(`${currentPart.title}: question ${currentPart.questions.length + 1} has no answer key.`)
    } else {
      currentPart.questions.push(makeQuestion(currentPart, prompt, currentQuestion.answer, currentQuestion.options, questionIndex))
      questionIndex += 1
    }
    currentQuestion = null
    afterAnswer = false
  }

  for (const line of lines) {
    if (isPartHeading(line)) {
      finishQuestion()
      currentPart = {
        id: localId('imported-part', parts.length),
        title: line.replace(/^part\s+/i, 'Part ').trim(),
        position: parts.length + 1,
        questions: [],
      }
      parts.push(currentPart)
      questionIndex = 0
      continue
    }

    if (!currentPart) continue

    if (isQuestionStart(line)) {
      finishQuestion()
      currentQuestion = { prompt: [questionText(line)], answer: '', options: [] }
      continue
    }

    if (!currentQuestion) continue
    if (isAnswerLine(line)) {
      currentQuestion.answer = answerText(line)
      afterAnswer = true
      continue
    }
    if (afterAnswer) continue
    if (isOptionLine(line)) {
      currentQuestion.options.push(optionText(line))
      continue
    }
    currentQuestion.prompt.push(line)
  }

  finishQuestion()

  const nonEmptyParts = parts.filter((part) => part.questions.length)
  if (!nonEmptyParts.length) warnings.push('No question parts were found in the PDF.')

  return {
    title,
    description: `Imported from ${fileName}`,
    parts: nonEmptyParts,
    warnings,
  }
}

type TextPage = {
  getTextContent: () => Promise<{ items: unknown[] }>
}

function asSubscript(value: string) {
  const subscriptDigits: Record<string, string> = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉', '-': '₋' }
  return value.replace(/[0-9-]/g, (character) => subscriptDigits[character] ?? character)
}

async function extractPageText(page: TextPage) {
  const content = await page.getTextContent()
  const lines: { y: number; items: { x: number; y: number; fontSize: number; text: string }[] }[] = []

  for (const item of content.items) {
    const candidate = item as Partial<TextItem>
    if (typeof candidate.str !== 'string' || !candidate.str.trim()) continue
    const textItem = candidate as TextItem
    const x = textItem.transform[4] ?? 0
    const y = textItem.transform[5] ?? 0
    const fontSize = Math.abs(textItem.transform[0] ?? 0)
    let line = lines.find((candidate) => Math.abs(candidate.y - y) < 8)
    if (!line) {
      line = { y, items: [] }
      lines.push(line)
    }
    line.y = Math.max(line.y, y)
    line.items.push({ x, y, fontSize, text: textItem.str })
  }

  return lines
    .sort((a, b) => b.y - a.y)
    .map((line) => {
      const baseline = Math.max(...line.items.map((item) => item.y))
      let output = ''
      return line.items.sort((a, b) => a.x - b.x).map((item) => {
        const isSubscript = item.y < baseline - 2 && item.fontSize < 12
        const value = isSubscript ? asSubscript(item.text) : item.text
        const prefix = !isSubscript && output ? ' ' : ''
        output += `${prefix}${value}`
        return `${prefix}${value}`
      }).join('')
    })
    .map(cleanLine)
    .filter(Boolean)
    .join('\n')
}

export async function importQuizPdf(file: File) {
  const data = new Uint8Array(await file.arrayBuffer())
  const pdf = await pdfjsLib.getDocument({ data }).promise
  const pages: string[] = []

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    pages.push(await extractPageText(await pdf.getPage(pageNumber)))
  }

  const text = pages.filter(Boolean).join('\n')
  if (!text.trim()) throw new Error('This PDF has no selectable text. Upload a text-based PDF instead of a scanned image.')
  return parseQuizText(text, file.name)
}
