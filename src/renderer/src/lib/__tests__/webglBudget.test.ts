import { describe, expect, it } from 'vitest'
import { HiddenWebglBudget } from '../webglBudget'

describe('HiddenWebglBudget', () => {
  it('lets terminals hide with their context up to the cap', () => {
    const budget = new HiddenWebglBudget(2)
    expect(budget.hide('t1')).toEqual([])
    expect(budget.hide('t2')).toEqual([])
  })

  it('takes the context from the terminal hidden longest ago once over the cap', () => {
    const budget = new HiddenWebglBudget(2)
    budget.hide('t1')
    budget.hide('t2')
    expect(budget.hide('t3')).toEqual(['t1'])
    expect(budget.hide('t4')).toEqual(['t2'])
  })

  it('does not count a terminal that was shown again', () => {
    const budget = new HiddenWebglBudget(2)
    budget.hide('t1')
    budget.hide('t2')
    budget.forget('t1')
    expect(budget.hide('t3')).toEqual([])
  })

  it('counts a terminal hidden twice once, as the most recent', () => {
    const budget = new HiddenWebglBudget(2)
    budget.hide('t1')
    budget.hide('t2')
    budget.hide('t1')
    expect(budget.hide('t3')).toEqual(['t2'])
  })

  it('ignores forgetting a terminal it never saw', () => {
    const budget = new HiddenWebglBudget(1)
    budget.forget('t9')
    expect(budget.hide('t1')).toEqual([])
  })
})
