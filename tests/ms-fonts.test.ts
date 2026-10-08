import { describe, expect, it } from 'vitest'
import { isMicrosoftFont } from '../src/shared/ms-fonts'

describe('isMicrosoftFont', () => {
  it('узнаёт шрифты Windows и Office, в том числе с начертанием', () => {
    for (const f of ['Aptos', 'Aptos Display', 'Segoe UI Semibold', 'Gill Sans MT', 'Franklin Gothic Book']) {
      expect(isMicrosoftFont(f), f).toBe(true)
    }
  })
  it('шрифты заказчика не трогает', () => {
    for (const f of ['SB Sans Display', 'Gotham Pro', 'Roboto Regular']) {
      expect(isMicrosoftFont(f), f).toBe(false)
    }
  })
})
