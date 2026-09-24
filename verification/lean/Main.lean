import Lean
import Lifecycle

open Lean Lifecycle

private def required (j : Json) (key : String) : Except String Json :=
  (j.getObjVal? key).mapError (fun _ => "missing field: " ++ key)

private def decimal (j : Json) : Except String Nat := do
  let s ← j.getStr?
  let n ← match s.toNat? with
    | some n => pure n
    | none => throw "expected canonical decimal string"
  if toString n != s then throw "expected canonical decimal string"
  return n

private def optionalNat (j : Json) (key : String) : Except String Nat :=
  match j.getObjVal? key with
  | .ok value => decimal value
  | .error _ => pure 0

private def optionalBool (j : Json) (key : String) (fallback : Bool) : Except String Bool :=
  match j.getObjVal? key with
  | .ok value => value.getBool?
  | .error _ => pure fallback

private def parseKind : String → Except String Kind
  | "prepare" => pure .prepare | "get" => pure .get | "all" => pure .all
  | "run" => pure .run | "iterate" => pure .iterate | "next" => pure .next
  | "return" => pure .ret | "dispose" => pure .dispose | "close" => pure .close
  | _ => throw "unknown operation"

private def parseFault : String → Except String Fault
  | "none" => pure .none | "prepare" => pure .prepare
  | "partialPrepare" => pure .partialPrepare | "step" => pure .step
  | "row" => pure .row | "reset" => pure .reset | "callback" => pure .callback
  | "verbose" => pure .verbose | "callbackReenter" => pure .callbackReenter
  | "verboseReenter" => pure .verboseReenter | "finalize" => pure .finalize
  | "resetCallback" => pure .resetCallback | "stepResetCallback" => pure .stepResetCallback
  | "resetReenter" => pure .resetReenter
  | _ => throw "unknown fault"

private def parseOp (j : Json) : Except String Op := do
  let kind ← parseKind (← (← required j "kind").getStr?)
  let fault ← match j.getObjVal? "fault" with
    | .ok value => parseFault (← value.getStr?)
    | .error _ => pure .none
  let statement ← optionalNat j "statement"
  let iterator ← optionalNat j "iterator"
  let address ← optionalNat j "address"
  let write ← optionalBool j "write" false
  let reader ← optionalBool j "reader" true
  if !reader && !write then throw "non-reader fixture requires write:true"
  if kind == .prepare then
    let _ ← decimal (← required j "address")
    pure ()
  if kind != .prepare && kind != .close then
    let _ ← decimal (← required j "statement")
    pure ()
  if kind == .next || kind == .ret then
    let _ ← decimal (← required j "iterator")
    pure ()
  return { kind, statement, iterator, address, fault, write, reader }

private def parseRequest (j : Json) : Except String (List Op) := do
  let version ← (← required j "v").getNat?
  if version != 1 then throw "unsupported protocol version"
  let ops ← (← required j "ops").getArr?
  ops.toList.mapM parseOp

private def optionalId (n : Option Nat) : Json :=
  Json.str (n.map toString |>.getD "")

private def eventJson (e : Event) : Json := Json.mkObj [
  ("kind", Json.str e.kind), ("allocation", optionalId e.allocation),
  ("address", optionalId e.address)]

private def stateJson (s : State) : Json := Json.mkObj [
  ("open", Json.bool s.isOpen), ("executing", Json.bool s.executing),
  ("iterators", Json.str (toString s.count)),
  ("statements", Json.arr ((s.cells.zipIdx.map fun (c, id) => Json.mkObj [
    ("allocation", Json.str (toString id)), ("address", Json.str (toString c.address)),
    ("live", Json.bool c.live), ("busy", Json.bool c.busy)]).toArray))]

private def answerJson (a : Answer) : Json := Json.mkObj [
  ("outcome", Json.str a.outcome), ("events", Json.arr (a.events.map eventJson).toArray),
  ("state", stateJson a.state)]

/-- This executable calls the very transition proved in Lifecycle.Proofs. -/
private def respond (ops : List Op) : Json := Id.run do
  let mut state : State := {}
  let mut steps : Array Json := #[]
  for op in ops do
    let answer := transition state op
    state := answer.state
    steps := steps.push (answerJson answer)
  return Json.mkObj [("v", toJson (1 : Nat)), ("steps", Json.arr steps)]

def main : IO UInt32 := do
  let input ← IO.getStdin
  let output ← IO.getStdout
  let error ← IO.getStderr
  repeat
    let line ← input.getLine
    if line.isEmpty then return 0
    if line.trimAscii.toString.isEmpty then continue
    match Json.parse line >>= parseRequest with
    | .ok ops => output.putStrLn (respond ops).compress
    | .error message =>
      error.putStrLn ("lifecycle protocol error: " ++ message)
      return 1
  return 0
