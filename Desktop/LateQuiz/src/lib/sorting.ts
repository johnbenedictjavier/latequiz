import type { Student } from '../types'

export function compareStudents(left: Student, right: Student) {
  return left.lastName.localeCompare(right.lastName, 'en', { sensitivity: 'base' })
    || left.firstNames.localeCompare(right.firstNames, 'en', { sensitivity: 'base' })
    || left.schoolId.localeCompare(right.schoolId, 'en', { sensitivity: 'base' })
}

export function sortStudents(students: Student[]) {
  return [...students].sort(compareStudents)
}
