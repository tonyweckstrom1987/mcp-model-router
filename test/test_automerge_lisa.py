import json
import pathlib
import subprocess
import importlib.util
import unittest
from unittest import mock

_POLKU = pathlib.Path(__file__).resolve().parent.parent / "tools" / "automerge.py"
_spec = importlib.util.spec_from_file_location("automerge_lisa_under_test", _POLKU)
am = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(am)

SHA = "a" * 40
PR = {"draft": False, "head_repo": "o/r", "base_repo": "o/r", "labels": [], "author": "tonyweckstrom1987",
      "head_ref": "korjaus/x", "base_ref": "main", "head_sha": SHA}
BOTTI_PR = dict(PR, head_repo="agenttifirma-bot/r", author="agenttifirma-bot", head_ref="yo/jotain")


def tied(nimi, changes=5, patch="@@ -1 +1 @@\n-a\n+b", **lisa):
    d = {"filename": nimi, "status": "modified", "changes": changes, "patch": patch}
    d.update(lisa)
    return d


def merkki(sha=SHA, paatos="HYVAKSYTTY"):
    return "<!-- riippumaton-tarkastus v1 sha=%s paatos=%s -->" % (sha, paatos)


def komento(stdout="", koodi=0, stderr=""):
    return mock.Mock(side_effect=lambda args, **kw: subprocess.CompletedProcess(args, koodi, stdout, stderr))


class LisatytRivitTesti(unittest.TestCase):
    def test_vain_lisatyt_rivit_ilman_etumerkkia(self):
        self.assertEqual(am._lisatyt_rivit("@@ -1,2 +1,2 @@\n-vanha\n+uusi\n ennallaan\n+toinen"), ["uusi", "toinen"])

    def test_tiedostootsikko_ohitetaan(self):
        self.assertEqual(am._lisatyt_rivit("+++ b/a.py\n+rivi"), ["rivi"])

    def test_tyhja_ja_puuttuva_patch(self):
        self.assertEqual(am._lisatyt_rivit(""), [])
        self.assertEqual(am._lisatyt_rivit(None), [])


class RajattuTesti(unittest.TestCase):
    def test_tyhja_tai_puuttuva_polku_on_polku_luokkaa(self):
        for polku in ("", None):
            self.assertEqual(am.rajattu("r", polku), "polku")

    def test_sallitut_merkit_ja_tavallinen_polku(self):
        self.assertIsNone(am.rajattu("r", "src/a-b_c.d/e+f@g.py"))

    def test_kielletyt_merkit_estavat(self):
        for polku in ("a\nb.py", "a;rm.py", "a$b.py", "a\tb.py", "ä.py"):
            self.assertEqual(am.rajattu("r", polku), "polku", repr(polku))

    def test_luokan_nimi_palautuu(self):
        self.assertEqual(am.rajattu("r", ".github/workflows/x.yml"), "tyonkulut (.github)")
        self.assertEqual(am.rajattu("r", "tools/automerge.py"), "automergen saannot")
        self.assertEqual(am.rajattu("r", "isanta/nftables.conf"), "palomuuri")
        self.assertEqual(am.rajattu("kauppatiimi", "salkku.py"), "oikea raha")
        self.assertIsNone(am.rajattu("r", "salkku.py"))

    def test_tyonkulku_vain_juuressa(self):
        self.assertIsNone(am.rajattu("r", "docs/.github/x.md"))

    def test_salaisuus_kirjainkoosta_riippumatta(self):
        for polku in ("TOKEN.txt", "docs/Password.md", "Api_Key.json", "PRIVATEKEY.txt", "a/ID_RSA"):
            self.assertEqual(am.rajattu("r", polku), "salaisuudet", polku)


class TarkastajanPaatosTesti(unittest.TestCase):
    def test_tyhja_ja_puuttuva_kommenttilista(self):
        self.assertIsNone(am.tarkastajan_paatos([], SHA))
        self.assertIsNone(am.tarkastajan_paatos(None, SHA))

    def test_tuntematon_paatosarvo_ei_kelpaa(self):
        body = "<!-- riippumaton-tarkastus v1 sha=%s paatos=JOKU_MUU -->" % SHA
        self.assertIsNone(am.tarkastajan_paatos([{"user": am.BOTTI, "body": body}], SHA))

    def test_merkki_voi_olla_muun_tekstin_seassa(self):
        body = "Alku\n" + merkki(paatos="RAJATTU") + "\nLoppu"
        self.assertEqual(am.tarkastajan_paatos([{"user": am.BOTTI, "body": body}], SHA), "RAJATTU")

    def test_vaarin_muotoiltu_sha_ei_kelpaa(self):
        for sha in ("a" * 39, "A" * 40, "g" * 40):
            body = "<!-- riippumaton-tarkastus v1 sha=%s paatos=HYVAKSYTTY -->" % sha
            self.assertIsNone(am.tarkastajan_paatos([{"user": am.BOTTI, "body": body}], sha), sha)

    def test_kommentti_ilman_kayttajaa_tai_runkoa(self):
        self.assertIsNone(am.tarkastajan_paatos([{}, {"user": am.BOTTI}], SHA))

    def test_muun_shan_kommentti_ei_ohita_aiempaa_paatosta(self):
        kommentit = [{"user": am.BOTTI, "body": merkki(paatos="HYLATTY")},
                     {"user": am.BOTTI, "body": merkki(sha="b" * 40)}]
        self.assertEqual(am.tarkastajan_paatos(kommentit, SHA), "HYLATTY")


class BotinForkkiSyytTesti(unittest.TestCase):
    def test_kelvollinen_botin_pr_ei_syita(self):
        self.assertEqual(am.botin_forkki_syyt(BOTTI_PR), [])

    def test_muu_tekija(self):
        self.assertEqual(am.botin_forkki_syyt(dict(BOTTI_PR, author="joku")), ["forkista vain botin PR"])

    def test_tekijan_kirjainkoolla_ei_ole_valia(self):
        self.assertEqual(am.botin_forkki_syyt(dict(BOTTI_PR, author="AgenttiFirma-Bot")), [])

    def test_head_repo_kirjainkoolla_ei_ole_valia(self):
        self.assertEqual(am.botin_forkki_syyt(dict(BOTTI_PR, head_repo="Agenttifirma-Bot/R")), [])

    def test_vaara_forkki(self):
        self.assertEqual(am.botin_forkki_syyt(dict(BOTTI_PR, head_repo="agenttifirma-bot/muu")),
                         ["forkki ei ole botin oma fork samasta reposta"])

    def test_puuttuva_base_repo(self):
        for base in (None, "", "ilman-omistajaa"):
            syyt = am.botin_forkki_syyt(dict(BOTTI_PR, base_repo=base))
            self.assertEqual(syyt, ["forkki ei ole botin oma fork samasta reposta"], base)

    def test_haaran_nimi(self):
        for ref in ("main", "yo/", "yo/A", "yo/-x", "yo/" + "a" * 61, None):
            self.assertEqual(am.botin_forkki_syyt(dict(BOTTI_PR, head_ref=ref)),
                             ["botin haaran nimi ei ole yo/<nimi>"], ref)
        for ref in ("yo/a", "yo/" + "a" * 60, "yo/a.b_c-d"):
            self.assertEqual(am.botin_forkki_syyt(dict(BOTTI_PR, head_ref=ref)), [], ref)

    def test_haara_ei_voi_paattya_rivinvaihtoon(self):
        self.assertEqual(am.botin_forkki_syyt(dict(BOTTI_PR, head_ref="yo/a\n")), ["botin haaran nimi ei ole yo/<nimi>"])

    def test_useampi_syy_kerralla(self):
        syyt = am.botin_forkki_syyt(dict(BOTTI_PR, author="joku", head_ref="main"))
        self.assertEqual(syyt, ["forkista vain botin PR", "botin haaran nimi ei ole yo/<nimi>"])


class RakenneSyytTesti(unittest.TestCase):
    def test_puhdas_pr_ei_syita(self):
        self.assertEqual(am.rakenne_syyt(PR, [tied("a.py")]), [])

    def test_syiden_tekstit(self):
        self.assertEqual(am.rakenne_syyt(dict(PR, draft=True), [tied("a.py")]), ["luonnos"])
        self.assertEqual(am.rakenne_syyt(dict(PR, base_ref="kehitys"), [tied("a.py")]), ["base ei ole main eika master"])
        self.assertEqual(am.rakenne_syyt(dict(PR, labels=["ei-automerge"]), [tied("a.py")]), ["tunniste ei-automerge"])
        self.assertEqual(am.rakenne_syyt(PR, []), ["ei tiedostoja"])

    def test_rajattu_repo_syy_sisaltaa_perustelun(self):
        pr = dict(PR, head_repo="o/agenttifirma-docs", base_repo="o/agenttifirma-docs")
        self.assertEqual(am.rakenne_syyt(pr, [tied("a.md")]), ["rajattu repo: Tonyn paatokset (docs-repo)"])

    def test_liian_monta_tiedostoa_ja_rivia(self):
        tiedostot = [tied("a%d.py" % i, changes=30) for i in range(am.MAX_TIEDOSTOA + 1)]
        syyt = am.rakenne_syyt(PR, tiedostot)
        self.assertIn("liian monta tiedostoa (%d)" % (am.MAX_TIEDOSTOA + 1), syyt)
        self.assertIn("liian suuri muutos (%d rivia)" % (30 * (am.MAX_TIEDOSTOA + 1)), syyt)

    def test_rivit_lasketaan_yhteen_tiedostojen_yli(self):
        self.assertEqual(am.rakenne_syyt(PR, [tied("a.py", changes=am.MAX_RIVEJA), tied("b.py", changes=1)]),
                         ["liian suuri muutos (%d rivia)" % (am.MAX_RIVEJA + 1)])

    def test_changes_puuttuu_tai_on_none(self):
        self.assertEqual(am.rakenne_syyt(PR, [{"filename": "a.py", "patch": "+x"}, tied("b.py", changes=None)]), [])

    def test_changes_voi_olla_merkkijono(self):
        self.assertEqual(am.rakenne_syyt(PR, [tied("a.py", changes="7")]), [])

    def test_rajattu_tiedosto_syyn_muoto(self):
        self.assertEqual(am.rakenne_syyt(PR, [tied("tools/automerge.py")]),
                         ["rajattu (automergen saannot): tools/automerge.py"])

    def test_sama_syy_ei_toistu(self):
        t = tied("tools/automerge.py", previous_filename="tools/automerge.py")
        self.assertEqual(am.rakenne_syyt(PR, [t]), ["rajattu (automergen saannot): tools/automerge.py"])

    def test_vanha_ja_uusi_nimi_antavat_kumpikin_syyn(self):
        t = tied("tools/automerge.py", previous_filename=".github/workflows/x.yml")
        syyt = am.rakenne_syyt(PR, [t])
        self.assertIn("rajattu (automergen saannot): tools/automerge.py", syyt)
        self.assertIn("rajattu (tyonkulut (.github)): .github/workflows/x.yml", syyt)

    def test_puuttuva_filename_on_polku_luokkaa(self):
        syyt = am.rakenne_syyt(PR, [{"changes": 1, "patch": "+x"}])
        self.assertEqual(syyt, [])
        syyt = am.rakenne_syyt(PR, [tied("", changes=1)])
        self.assertEqual(syyt, ["rajattu (polku): "])

    def test_patch_puuttuu_vain_kun_rivit_muuttuvat(self):
        self.assertEqual(am.rakenne_syyt(PR, [tied("a.bin", changes=0, patch=None)]), [])
        self.assertEqual(am.rakenne_syyt(PR, [tied("a.bin", changes=3, patch=None)]),
                         ["patch puuttuu (binaari tai liian suuri): a.bin"])

    def test_tyhja_patch_ei_ole_puuttuva(self):
        self.assertEqual(am.rakenne_syyt(PR, [tied("a.py", changes=3, patch="")]), [])

    def test_osoite_syy_per_tiedosto(self):
        osoite = "10." + "1.2.3"
        syyt = am.rakenne_syyt(PR, [tied("a.py", patch="+" + osoite), tied("b.py"), tied("c.py", patch="+" + osoite)])
        self.assertEqual(syyt, ["lisatylla rivilla yksityinen osoite tai tailnet-nimi: a.py",
                                "lisatylla rivilla yksityinen osoite tai tailnet-nimi: c.py"])

    def test_osoite_ei_laukea_kontekstirivilla(self):
        osoite = "192." + "168.0.1"
        self.assertEqual(am.rakenne_syyt(PR, [tied("a.py", patch="@@\n " + osoite + "\n-" + osoite)]), [])

    def test_osoite_kirjainkoolla_ei_ole_valia(self):
        self.assertTrue(am.rakenne_syyt(PR, [tied("a.py", patch="+HOST.TS" + ".NET")]))

    def test_osoite_vaatii_sanarajan(self):
        self.assertEqual(am.rakenne_syyt(PR, [tied("a.py", patch="+v110." + "0.0.1x")]), [])

    def test_tailnetin_cgnat_alueen_rajat(self):
        for ip, odotettu in (("100.64.0.1", True), ("100.127.255.254", True), ("100.128.0.1", False), ("100.63.9.9", False)):
            syyt = am.rakenne_syyt(PR, [tied("a.py", patch="+x " + ip)])
            self.assertEqual(bool(syyt), odotettu, ip)

    def test_172_alueen_rajat(self):
        for ip, odotettu in (("172.16.0.1", True), ("172.31.255.1", True), ("172.15.0.1", False), ("172.32.0.1", False)):
            syyt = am.rakenne_syyt(PR, [tied("a.py", patch="+x " + ip)])
            self.assertEqual(bool(syyt), odotettu, ip)


class ArvioiTesti(unittest.TestCase):
    def test_hyvaksynta_ja_rakenne_yhdessa(self):
        kommentit = [{"user": am.BOTTI, "body": merkki()}]
        self.assertEqual(am.arvioi(PR, [tied("a.py")], kommentit), (True, []))

    def test_rakennesyyt_ja_odotus_tulevat_yhdessa(self):
        ok, syyt = am.arvioi(dict(PR, draft=True), [tied("a.py")])
        self.assertFalse(ok)
        self.assertEqual(syyt, ["luonnos", "riippumaton tarkastus: odottaa"])

    def test_puuttuva_head_sha_odottaa(self):
        pr = {k: v for k, v in PR.items() if k != "head_sha"}
        ok, syyt = am.arvioi(pr, [tied("a.py")], [{"user": am.BOTTI, "body": merkki()}])
        self.assertFalse(ok)
        self.assertEqual(syyt, ["riippumaton tarkastus: odottaa"])

    def test_kommentit_oletuksena_tyhja(self):
        self.assertEqual(am.arvioi(PR, [tied("a.py")]), (False, ["riippumaton tarkastus: odottaa"]))


class HaeFunktiotTesti(unittest.TestCase):
    def test_hae_pr_muuntaa_kentat(self):
        d = {"draft": 1, "state": "open", "user": {"login": "u"},
             "head": {"repo": {"full_name": "f/r"}, "ref": "yo/x", "sha": SHA},
             "base": {"repo": {"full_name": "o/r"}, "ref": "main"},
             "labels": [{"name": "a"}, {"name": "b"}]}
        with mock.patch.object(am.subprocess, "run", komento(json.dumps(d))) as run:
            pr = am.hae_pr("o/r", "7")
        run.assert_called_once()
        self.assertEqual(run.call_args[0][0], ["gh", "api", "repos/o/r/pulls/7"])
        self.assertEqual(pr, {"draft": True, "state": "open", "head_repo": "f/r", "base_repo": "o/r", "labels": ["a", "b"],
                              "author": "u", "head_ref": "yo/x", "head_sha": SHA, "base_ref": "main"})

    def test_hae_pr_poistettu_forkki_ja_puuttuvat_kentat(self):
        d = {"head": {"repo": None, "ref": "x", "sha": SHA}, "base": {"repo": {"full_name": "o/r"}, "ref": "main"}, "user": None}
        with mock.patch.object(am.subprocess, "run", komento(json.dumps(d))):
            pr = am.hae_pr("o/r", "7")
        self.assertIsNone(pr["head_repo"])
        self.assertIsNone(pr["author"])
        self.assertIsNone(pr["state"])
        self.assertFalse(pr["draft"])
        self.assertEqual(pr["labels"], [])

    def test_hae_pr_tyhja_objekti(self):
        with mock.patch.object(am.subprocess, "run", komento("{}")):
            pr = am.hae_pr("o/r", "7")
        self.assertEqual(pr, {"draft": False, "state": None, "head_repo": None, "base_repo": None, "labels": [],
                              "author": None, "head_ref": None, "head_sha": None, "base_ref": None})

    def test_hae_pr_virhe_kayttaa_stderrin_lopun(self):
        with mock.patch.object(am.subprocess, "run", komento("", 1, "x" * 300)):
            with self.assertRaises(RuntimeError) as e:
                am.hae_pr("o/r", "7")
        self.assertEqual(str(e.exception), "PR:n haku epaonnistui: " + "x" * 200)

    def test_hae_pr_rikkinainen_json_nostaa_valueerrorin(self):
        with mock.patch.object(am.subprocess, "run", komento("ei json")):
            with self.assertRaises(ValueError):
                am.hae_pr("o/r", "7")

    def test_hae_tiedostot_jasentaa_rivit_ja_ohittaa_tyhjat(self):
        ulos = json.dumps({"filename": "a.py"}) + "\n\n   \n" + json.dumps({"filename": "b.py"}) + "\n"
        with mock.patch.object(am.subprocess, "run", komento(ulos)) as run:
            self.assertEqual(am.hae_tiedostot("o/r", "7"), [{"filename": "a.py"}, {"filename": "b.py"}])
        self.assertEqual(run.call_args[0][0],
                         ["gh", "api", "--paginate", "repos/o/r/pulls/7/files?per_page=100", "--jq", ".[]"])

    def test_hae_kommentit_jasentaa_rivit(self):
        ulos = json.dumps({"user": "u", "body": "x"}) + "\n"
        with mock.patch.object(am.subprocess, "run", komento(ulos)) as run:
            self.assertEqual(am.hae_kommentit("o/r", "7"), [{"user": "u", "body": "x"}])
        self.assertEqual(run.call_args[0][0][:3], ["gh", "api", "--paginate"])
        self.assertEqual(run.call_args[0][0][3], "repos/o/r/issues/7/comments?per_page=100")

    def test_tyhja_vastaus_antaa_tyhjan_listan(self):
        with mock.patch.object(am.subprocess, "run", komento("")):
            self.assertEqual(am.hae_tiedostot("o/r", "7"), [])
            self.assertEqual(am.hae_kommentit("o/r", "7"), [])

    def test_hae_tiedostot_virheen_loppu_kasitellaan(self):
        with mock.patch.object(am.subprocess, "run", komento("", 1, "y" * 300)):
            with self.assertRaises(RuntimeError) as e:
                am.hae_tiedostot("o/r", "7")
        self.assertEqual(str(e.exception), "tiedostojen haku epaonnistui: " + "y" * 200)


class MainLisaTesti(unittest.TestCase):
    ENV = {"GITHUB_REPOSITORY": "o/r", "PR_NUMBER": "7"}

    def aja(self, kutsut_vastaus):
        kutsut = []

        def f(args, **kw):
            kutsut.append(args)
            return kutsut_vastaus(args)
        with mock.patch.dict("os.environ", self.ENV, clear=False), mock.patch.object(am.subprocess, "run", f), \
                mock.patch("builtins.print") as tuloste:
            koodi = am.main()
        return koodi, kutsut, tuloste

    def test_rikkinainen_json_ei_tee_mitaan(self):
        koodi, kutsut, tuloste = self.aja(lambda a: subprocess.CompletedProcess(a, 0, "ei json", ""))
        self.assertEqual(koodi, 1)
        self.assertTrue(tuloste.call_args[0][0].startswith("Automerge: arviointi epaonnistui ("))
        self.assertTrue(tuloste.call_args[0][0].endswith("), ei tehda mitaan"))
        self.assertFalse(any(k[1:3] == ["pr", "merge"] for k in kutsut))

    def vastaus(self, state="open", kommentit=True):
        def f(args):
            osat = args[1:]
            if osat[0] == "api" and "--paginate" in osat:
                if "/comments" in osat[2]:
                    ulos = json.dumps({"user": am.BOTTI, "body": merkki()}) if kommentit else ""
                else:
                    ulos = json.dumps(tied("a.py"))
            elif osat[0] == "api":
                d = {"draft": False, "user": {"login": "x"}, "head": {"repo": {"full_name": "o/r"}, "ref": "k", "sha": SHA},
                     "base": {"repo": {"full_name": "o/r"}, "ref": "main"}, "labels": []}
                if state is not None:
                    d["state"] = state
                ulos = json.dumps(d)
            else:
                ulos = ""
            return subprocess.CompletedProcess(args, 0, ulos, "")
        return f

    def test_puuttuva_state_ei_estaa_arviointia(self):
        koodi, kutsut, tuloste = self.aja(self.vastaus(state=None))
        self.assertEqual(koodi, 0)
        self.assertIn(["gh", "pr", "merge", "7", "--auto", "--squash", "--match-head-commit", SHA, "--repo", "o/r"], kutsut)

    def test_onnistumisviesti_nayttaa_lyhyen_shan(self):
        _, _, tuloste = self.aja(self.vastaus())
        self.assertEqual(tuloste.call_args[0][0],
                         "Automerge: PR #7 kelpaa (tarkastaja hyvaksyi %s). Yhdistyy kun tarkistukset ovat lapi." % SHA[:7])

    def test_suljettu_pr_viesti(self):
        koodi, _, tuloste = self.aja(self.vastaus(state="closed"))
        self.assertEqual(koodi, 0)
        self.assertEqual(tuloste.call_args[0][0], "Automerge: PR #7 ei ole auki, ei tehda mitaan")

    def test_kelpaamattoman_viesti_listaa_syyt_puolipisteella(self):
        koodi, kutsut, tuloste = self.aja(self.vastaus(kommentit=False))
        self.assertEqual(koodi, 0)
        self.assertEqual(tuloste.call_args[0][0],
                         "Automerge: PR #7 ei kelpaa automaattiseen yhdistamiseen: riippumaton tarkastus: odottaa. "
                         "Auto-merge poistettu.")
        self.assertNotIn("--auto", [a for k in kutsut for a in k])

    def test_disable_auto_virhe_ei_kaada_ajoa(self):
        def f(args):
            if "--disable-auto" in args:
                return subprocess.CompletedProcess(args, 1, "", "ei onnistu")
            return self.vastaus(kommentit=False)(args)
        koodi, kutsut, _ = self.aja(f)
        self.assertEqual(koodi, 0)
        self.assertIn(["gh", "pr", "merge", "7", "--disable-auto", "--repo", "o/r"], kutsut)

    def test_ymparisto_puuttuu(self):
        for env in ({"GITHUB_REPOSITORY": "", "PR_NUMBER": "7"}, {"GITHUB_REPOSITORY": "o/r", "PR_NUMBER": ""},
                    {"GITHUB_REPOSITORY": "o/r/x", "PR_NUMBER": "7"}, {"GITHUB_REPOSITORY": "o r/x", "PR_NUMBER": "7"},
                    {"GITHUB_REPOSITORY": "o/r", "PR_NUMBER": "7; rm"}):
            with mock.patch.dict("os.environ", env, clear=False), mock.patch("builtins.print") as p, \
                    mock.patch.object(am.subprocess, "run") as run:
                self.assertEqual(am.main(), 2, env)
            run.assert_not_called()
            p.assert_called_once_with("virheellinen GITHUB_REPOSITORY tai PR_NUMBER")


class VakiotTesti(unittest.TestCase):
    def test_tarkastajiksi_vain_botti(self):
        self.assertEqual(am.TARKASTAJAT, (am.BOTTI,))

    def test_rajat(self):
        self.assertEqual((am.MAX_TIEDOSTOA, am.MAX_RIVEJA), (60, 1500))

    def test_rajatut_repot_ovat_edelleen_rajattuja(self):
        self.assertEqual(set(am.RAJATUT_REPOT), {"tonyweckstrom1987.github.io", "agenttifirma-docs"})


if __name__ == "__main__":
    unittest.main()
