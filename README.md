# PokéScanner

PWA para digitalizar cartas Pokémon, reconhecer texto por OCR, pesquisar na Pokémon TCG API e exportar coleções em CSV (Cardmarket, TCGPowerTools).

https://lagoavc.github.io/pokemon-scanner-pwa/

## Funcionalidades

- **Câmara** — captura a carta com guia de enquadramento
- **OCR** — extrai nome, número de colecionador e expansão via OCR.space
- **Pesquisa** — resultados da Pokémon TCG API com auto-suggest
- **Preços** — preço médio do Cardmarket via TCGdex (avg / avg-holo)
- **Coleção** — persistente no localStorage, exportável em CSV (3 formatos) e JSON
- **PWA** — instalável no ecrã inicial, funciona offline (vista da coleção)
- **Privacidade** — API key do OCR fica apenas no dispositivo

## APIs

| API | Uso | Custo |
|---|---|---|
| [OCR.space](https://ocr.space) | Reconhecimento de texto nas imagens | Gratuito (10 req/dia) — cada utilizador usa a sua key |
| [Pokémon TCG API](https://pokemontcg.io) | Pesquisa de cartas (nome, set, número, imagem) | Gratuito sem key |
| [TCGdex](https://tcgdex.dev) | Preços Cardmarket (avg, trend, avg-holo) | Gratuito sem key |

## Tecnologias

- HTML / CSS / JavaScript (vanilla, sem frameworks)
- Service Worker (cache offline)
- Python (servidor opcional legado — já não necessário)

## Como usar

1. Abrir o site, aceitar o aviso de privacidade
2. Ir a **Ajuda** > obter API key no OCR.space > colar e guardar
3. Apontar a câmara à carta e capturar
4. Confirmar dados, selecionar a carta na pesquisa
5. Ajustar estado/idioma/preço e adicionar à lista
6. Exportar CSV ou JSON quando terminar

## Desktop (futuro projeto)

Versão sem câmara: inserir sigla do set + número de colecionador para obter dados e preço da carta.
